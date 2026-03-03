// index.js — Navin Nati (नवीन नाती) WhatsApp Matrimony Bot
// Meta Cloud API + Google Sheets + Google Drive
// Features:
// - Max 2 profiles per phone (JOIN/NewProfile blocked if 2)
// - MYPROFILES, DELETE MH-XXXX
// - Admin approve/reject
// - Only APPROVED can browse matches; results only APPROVED
// - 18+ enforced on registration and results
// - Photo stored permanently in Google Drive; stored in profiles.photo_url (public link)
// - MATCHES: auto opposite gender + asks basic filters; shows 5 results + NEXT/PREV
// - DETAILS MH-XXXX: max 5/month; sends photo as WhatsApp image + details
// - INTEREST MH-XXXX: max 5/month; notifies target; ACCEPT/REJECT to share contact
// - requests sheet columns: A req_id, B from_profile_id, C to_profile_id, D status, E created_at, F type, G viewer_phone

require("dotenv").config();

const { Readable } = require("stream");
const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json());

// ===================== BRAND =====================
const BRAND_NAME = "Navin Nati (नवीन नाती)";
const BRAND_TAGLINE = "नवीन नाती – विश्वासाने जोडलेली.";
const BRAND_WELCOME_LINE = "विश्वासाने जुळवा योग्य स्थळ.";

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || "");
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || ""; // REQUIRED for permanent photo

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !SHEET_ID) {
  console.warn("⚠️ Missing required env vars. Check VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, GOOGLE_SHEET_ID.");
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.warn("⚠️ Missing GOOGLE_SERVICE_ACCOUNT_JSON env var.");
}
if (!DRIVE_FOLDER_ID) {
  console.warn("⚠️ Missing GOOGLE_DRIVE_FOLDER_ID env var. Permanent photo storage will NOT work.");
}

// ===================== CONSTANTS =====================
const PROFILE_TAB = "profiles";
const STATE_TAB = "state";
const REQUESTS_TAB = "requests";

const MAX_PROFILES_PER_PHONE = 2;
const MIN_AGE = 18;

const MAX_DETAILS_PER_MONTH = 5;
const MAX_INTEREST_PER_MONTH = 5;

const RESULTS_PAGE_SIZE = 5;

// ===================== Utils =====================
function normalizePhone(p) {
  return (p || "").toString().replace(/\D/g, "");
}

function nowISO() {
  return new Date().toISOString();
}

function monthKey(isoString = nowISO()) {
  // YYYY-MM
  return isoString.slice(0, 7);
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  // Safer: exact match only (recommended). If you really want last-10 match, uncomment.
  return f === ADMIN_PHONE;
  // return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

function parseCommand(text) {
  const parts = (text || "").trim().split(/\s+/);
  return { cmd: (parts[0] || "").toUpperCase(), args: parts.slice(1) };
}

function calcAgeFromDobDDMMYYYY(dob) {
  // dob = DD-MM-YYYY
  if (!/^\d{2}-\d{2}-\d{4}$/.test(dob || "")) return null;
  const [dd, mm, yyyy] = dob.split("-").map((x) => parseInt(x, 10));
  if (!dd || !mm || !yyyy) return null;

  const birth = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (Number.isNaN(birth.getTime())) return null;

  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  let age = todayUTC.getUTCFullYear() - birth.getUTCFullYear();
  const m = todayUTC.getUTCMonth() - birth.getUTCMonth();
  if (m < 0 || (m === 0 && todayUTC.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

// ===================== Webhook Dedupe (Meta retries) =====================
const processedMsgIds = new Map(); // msgId -> timestamp

function isDuplicateMsg(msgId) {
  if (!msgId) return false;
  const now = Date.now();

  // cleanup older than 10 minutes
  for (const [k, t] of processedMsgIds.entries()) {
    if (now - t > 10 * 60 * 1000) processedMsgIds.delete(k);
  }

  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.set(msgId, now);
  return false;
}

// ===================== Google Auth / Clients =====================
function getAuth() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "");
  } catch (e) {
    console.error("❌ GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    throw e;
  }

  return new GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

async function getDriveClient() {
  const auth = getAuth();
  return google.drive({ version: "v3", auth });
}

// ===================== WhatsApp Cloud API =====================
async function sendText(to, body) {
  const phone = normalizePhone(to);
  if (!phone) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );
  } catch (e) {
    console.error("sendText failed:", e?.response?.data || e.message);
  }
}

async function sendImageByLink(to, imageLink, caption = "") {
  const phone = normalizePhone(to);
  if (!phone) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "image",
        image: {
          link: imageLink, // public URL
          ...(caption ? { caption } : {}),
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );
  } catch (e) {
    console.error("sendImageByLink failed:", e?.response?.data || e.message);
  }
}

async function getMetaMediaUrl(mediaId) {
  const r = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 20000,
  });
  return r.data?.url || "";
}

async function downloadMetaMediaBytes(mediaUrl) {
  const r = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 30000,
  });
  return {
    bytes: r.data,
    contentType: r.headers["content-type"] || "image/jpeg",
  };
}

// ===================== Google Drive Photo Storage =====================
// ===================== Google Drive Photo Storage =====================
async function uploadPhotoToDrive(bytes, contentType, filename) {
  if (!DRIVE_FOLDER_ID) return "";

  const drive = await getDriveClient();

  try {
    // Convert bytes -> Buffer -> Readable stream (IMPORTANT FIX)
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const stream = Readable.from(buffer);

    const createRes = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: contentType || "image/jpeg",
        body: stream, // MUST be stream (fixes pipe error)
      },
      fields: "id",
    });

    const fileId = createRes.data?.id;
    if (!fileId) return "";

    // Make file public
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });

    // WhatsApp-friendly direct link
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  } catch (err) {
    console.error("Drive upload error:", err?.response?.data || err.message);
    return "";
  }
}

// ===================== Sheets: STATE =====================
async function getState(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${STATE_TAB}!A:D`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i][0] || "";
    const step = rows[i][1] || "";
    const temp_data = rows[i][2] || "{}";
    if (p === phone) return { step, temp_data };
  }
  return { step: "", temp_data: "{}" };
}

async function setState(phone, step, tempObj) {
  const sheets = await getSheetsClient();
  const updatedAt = nowISO();
  const temp_data = JSON.stringify(tempObj || {});

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${STATE_TAB}!A:D`,
  });
  const rows = res.data.values || [];

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "") === phone) {
      rowIndex = i + 1; // 1-based
      break;
    }
  }

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${STATE_TAB}!A:D`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp_data, updatedAt]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${STATE_TAB}!A${rowIndex}:D${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp_data, updatedAt]] },
    });
  }
}

// ===================== Sheets: PROFILES =====================
// profiles columns A-Q:
// A profile_id
// B phone
// C name
// D surname
// E gender
// F date_of_birth
// G religion
// H height
// I caste
// J city
// K district
// L education
// M job
// N income_annual
// O photo_url
// P status
// Q created_at

async function getAllProfilesRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:Q`,
  });
  return res.data.values || [];
}

function profileRowToObj(row, rowIndex1Based) {
  return {
    rowIndex: rowIndex1Based,
    profile_id: row?.[0] || "",
    phone: row?.[1] || "",
    name: row?.[2] || "",
    surname: row?.[3] || "",
    gender: (row?.[4] || "").toLowerCase(),
    date_of_birth: row?.[5] || "",
    religion: row?.[6] || "",
    height: row?.[7] || "",
    caste: row?.[8] || "",
    city: row?.[9] || "",
    district: row?.[10] || "",
    education: row?.[11] || "",
    job: row?.[12] || "",
    income_annual: row?.[13] || "",
    photo_url: row?.[14] || "",
    status: (row?.[15] || "").toUpperCase(),
    created_at: row?.[16] || "",
  };
}

async function findProfilesByPhone(phone) {
  const rows = await getAllProfilesRows();
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = profileRowToObj(rows[i], i + 1);
    if (obj.phone === phone) list.push(obj);
  }
  return list; // oldest..newest (append order)
}

async function findProfileById(profileId) {
  const rows = await getAllProfilesRows();
  for (let i = 1; i < rows.length; i++) {
    const obj = profileRowToObj(rows[i], i + 1);
    if ((obj.profile_id || "").trim() === (profileId || "").trim()) return obj;
  }
  return null;
}

async function updateProfileStatus(rowIndex1Based, newStatus) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!P${rowIndex1Based}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newStatus]] },
  });
}

async function getProfilesSheetId() {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find((s) => s.properties?.title === PROFILE_TAB);
  if (!sheet) throw new Error(`Sheet tab '${PROFILE_TAB}' not found`);
  return sheet.properties.sheetId;
}

async function deleteProfileRow(rowIndex1Based) {
  const sheets = await getSheetsClient();
  const sheetId = await getProfilesSheetId();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex1Based - 1, // 0-based inclusive
              endIndex: rowIndex1Based, // exclusive
            },
          },
        },
      ],
    },
  });
}

async function generateUniqueProfileId() {
  const rows = await getAllProfilesRows();
  const existing = new Set(rows.map((r) => (r?.[0] || "").toString()));
  for (let attempt = 0; attempt < 30; attempt++) {
    const id = `MH-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!existing.has(id)) return id;
  }
  return `MH-${Date.now().toString().slice(-4)}`;
}

async function createProfile(phone, temp) {
  const sheets = await getSheetsClient();
  const profile_id = await generateUniqueProfileId();
  const createdAt = nowISO();

  const row = [
    profile_id,                 // A profile_id
    phone,                      // B phone
    temp.name || "",            // C name
    temp.surname || "",         // D surname
    temp.gender || "",          // E gender
    temp.date_of_birth || "",   // F date_of_birth
    temp.religion || "",        // G religion
    temp.height || "",          // H height
    temp.caste || "",           // I caste
    temp.city || "",            // J city
    temp.district || "",        // K district
    temp.education || "",       // L education
    temp.job || "",             // M job
    temp.income_annual || "",   // N income_annual
    temp.photo_url || "",       // O photo_url
    "PENDING",                  // P status
    createdAt,                  // Q created_at
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:Q`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  return profile_id;
}

function getLatestApprovedProfile(profiles) {
  for (let i = profiles.length - 1; i >= 0; i--) {
    if (profiles[i].status === "APPROVED") return profiles[i];
  }
  return null;
}

// ===================== Sheets: REQUESTS =====================
// requests columns A-G:
// A req_id
// B from_profile_id
// C to_profile_id
// D status
// E created_at (ISO)
// F type (DETAILS/INTEREST)
// G viewer_phone (phone number)

async function getAllRequestsRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_TAB}!A:G`,
  });
  return res.data.values || [];
}

function requestRowToObj(row, rowIndex1Based) {
  return {
    rowIndex: rowIndex1Based,
    req_id: row?.[0] || "",
    from_profile_id: row?.[1] || "",
    to_profile_id: row?.[2] || "",
    status: (row?.[3] || "").toUpperCase(),
    created_at: row?.[4] || "",
    type: (row?.[5] || "").toUpperCase(), // DETAILS / INTEREST
    viewer_phone: row?.[6] || "",
  };
}

async function appendRequest({ from_profile_id, to_profile_id, status, type, viewer_phone }) {
  const sheets = await getSheetsClient();
  const req_id = `REQ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const created_at = nowISO();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_TAB}!A:G`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[req_id, from_profile_id, to_profile_id, status, created_at, type, viewer_phone]],
    },
  });

  return req_id;
}

async function updateRequestStatus(rowIndex1Based, newStatus) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_TAB}!D${rowIndex1Based}`, // status column D
    valueInputOption: "RAW",
    requestBody: { values: [[newStatus]] },
  });
}

async function countThisMonth({ from_profile_id, type }) {
  const rows = await getAllRequestsRows();
  const key = monthKey();

  let cnt = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = requestRowToObj(rows[i], i + 1);
    if (r.from_profile_id === from_profile_id && r.type === type && (r.created_at || "").startsWith(key)) {
      cnt++;
    }
  }
  return cnt;
}

async function findInterestRequest({ from_profile_id, to_profile_id }) {
  const rows = await getAllRequestsRows();
  for (let i = 1; i < rows.length; i++) {
    const r = requestRowToObj(rows[i], i + 1);
    if (r.type === "INTEREST" && r.from_profile_id === from_profile_id && r.to_profile_id === to_profile_id) {
      return r;
    }
  }
  return null;
}

// ===================== Admin Notify =====================
async function notifyAdminNewProfile(profileId, phone, temp) {
  if (!ADMIN_PHONE) return;

  const msg =
`🆕 New Registration (PENDING)

Profile ID: ${profileId}
Phone: ${phone}
Name: ${(temp?.name || "")} ${(temp?.surname || "")}
Gender: ${temp?.gender || ""}
DOB: ${temp?.date_of_birth || ""}
Height: ${temp?.height || ""}
Religion: ${temp?.religion || ""}
Caste: ${temp?.caste || ""}
City: ${temp?.city || ""}, ${temp?.district || ""}
Education: ${temp?.education || ""}
Job: ${temp?.job || ""}
Income: ${temp?.income_annual || ""}

✅ Approve: approve ${profileId}
❌ Reject: reject ${profileId}`;

  await sendText(ADMIN_PHONE, msg);
}

// ===================== Matching / Search Helpers =====================
function educationRank(edu) {
  const e = (edu || "").toLowerCase();
  if (e.includes("phd") || e.includes("doctor")) return 4;
  if (e.includes("mba") || e.includes("mtech") || e.includes("ms") || e.includes("post")) return 3;
  if (e.includes("be") || e.includes("btech") || e.includes("b.") || e.includes("graduate")) return 2;
  return 1;
}

function parseIncomeLPA(incomeText) {
  const m = (incomeText || "").match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  return parseFloat(m[1]);
}

function oppositeGender(g) {
  const x = (g || "").toLowerCase();
  if (x === "male") return "female";
  if (x === "female") return "male";
  return "";
}

function buildProfileCardLine(p) {
  const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
  const ageTxt = age !== null ? `${age}` : "NA";
  return `• ${p.profile_id} | Age: ${ageTxt} | ${p.city} (${p.district}) | ${p.education} | ${p.job}`;
}

function applyFiltersToApprovedProfiles(allProfiles, opts) {
  const out = [];

  for (const p of allProfiles) {
    if (p.status !== "APPROVED") continue;

    const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
    if (age === null || age < MIN_AGE) continue;

    if (opts.targetGender && (p.gender || "").toLowerCase() !== opts.targetGender) continue;

    if (opts.cityScope === "SAME_CITY" && opts.userCity) {
      if ((p.city || "").toLowerCase() !== (opts.userCity || "").toLowerCase()) continue;
    }

    if (opts.ageMin !== null && age < opts.ageMin) continue;
    if (opts.ageMax !== null && age > opts.ageMax) continue;

    if (opts.casteScope === "SAME_CASTE" && opts.userCaste) {
      if ((p.caste || "").toLowerCase() !== (opts.userCaste || "").toLowerCase()) continue;
    }

    if (opts.eduMinRank !== null) {
      if (educationRank(p.education) < opts.eduMinRank) continue;
    }

    if (opts.incomeMin !== null) {
      const lpa = parseIncomeLPA(p.income_annual);
      if (lpa === null || lpa < opts.incomeMin) continue;
    }

    out.push(p);
  }

  return out;
}

async function sendResultsPage(to, searchState) {
  const { results = [], page = 0 } = searchState;
  if (!results.length) {
    await sendText(to, "No matches found with your preferences. Try again with different filters.");
    return;
  }

  const start = page * RESULTS_PAGE_SIZE;
  const end = start + RESULTS_PAGE_SIZE;
  const chunk = results.slice(start, end);

  let msg = `🔎 Matches (${start + 1}-${Math.min(end, results.length)} of ${results.length})\n\n`;
  msg += chunk.map(buildProfileCardLine).join("\n");
  msg += `\n\nCommands:\nNEXT | PREV\nDETAILS MH-XXXX\nINTEREST MH-XXXX`;

  await sendText(to, msg);
}

// ===================== Health =====================
app.get("/health", (req, res) => res.status(200).send("OK"));

// ===================== Webhook Verify (GET) =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== Webhook Receive (POST) =====================
app.post("/webhook", async (req, res) => {
  // Reply fast to Meta
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    if (isDuplicateMsg(msg.id)) return;

    const from = normalizePhone(msg.from);
    const msgType = msg.type; // "text", "image", etc.
    const text = (msg.text?.body || "").trim();

    // Load state early
    const st = await getState(from);
    const temp = safeJsonParse(st.temp_data || "{}", {});
    const { cmd, args } = parseCommand(text);

    // ===================== GLOBAL CANCEL =====================
    if (cmd === "STOP" || cmd === "CANCEL") {
      await setState(from, "", {});
      await sendText(from, "✅ Cancelled. Type *JOIN* to start again.");
      return;
    }

    // ===================== ADMIN COMMANDS =====================
    if (text && (cmd === "APPROVE" || cmd === "REJECT")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can approve/reject profiles.");
        return;
      }
      const profileId = args[0];
      if (!profileId) {
        await sendText(from, "Use: approve MH-XXXX  OR  reject MH-XXXX");
        return;
      }

      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.");
        return;
      }

      const newStatus = cmd === "APPROVE" ? "APPROVED" : "REJECTED";
      await updateProfileStatus(prof.rowIndex, newStatus);

      if (cmd === "APPROVE") {
        // ✅ Brand message only here (per your instruction)
        await sendText(
          prof.phone,
          `🎉 Your profile *${profileId}* has been *APPROVED*.

🌸 *${BRAND_NAME}*
${BRAND_TAGLINE}

Type *MATCHES* to browse profiles.`
        );
        await sendText(from, `✅ Approved ${profileId}`);
      } else {
        await sendText(prof.phone, `❌ Your profile *${profileId}* was *REJECTED*.\nYou can create a new profile after deleting this one.`);
        await sendText(from, `✅ Rejected ${profileId}`);
      }
      return;
    }

    // ===================== USER COMMANDS: MYPROFILES =====================
    if (cmd === "MYPROFILES") {
      const profiles = await findProfilesByPhone(from);
      if (!profiles.length) {
        await sendText(from, "You have no profiles. Type *JOIN* to create one.");
        return;
      }
      const lines = profiles.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`);
      await sendText(from, `Your profiles:\n${lines.join("\n")}\n\nDelete: *DELETE MH-XXXX*\nCreate new: *JOIN* (max 2)`);
      return;
    }

    // ===================== USER COMMANDS: DELETE MH-XXXX =====================
    if (cmd === "DELETE") {
      const profileId = args[0];
      if (!profileId) {
        await sendText(from, "Use: DELETE MH-XXXX");
        return;
      }
      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.");
        return;
      }
      if (prof.phone !== from) {
        await sendText(from, "❌ You can delete only your own profile.");
        return;
      }

      await deleteProfileRow(prof.rowIndex);
      await setState(from, "", {});
      await sendText(from, `✅ Deleted ${profileId}.\nType *JOIN* to create a new profile.`);
      return;
    }

    // ===================== MATCHES / SEARCH FLOW =====================
    if (cmd === "MATCHES" || cmd === "SEARCH") {
      const profiles = await findProfilesByPhone(from);
      const active = getLatestApprovedProfile(profiles);

      if (!active) {
        await sendText(from, "⏳ Your profile is not approved yet. Please wait for approval to browse matches.");
        return;
      }

      const targetGender = oppositeGender(active.gender);
      if (!targetGender) {
        await sendText(from, "Your gender is missing in profile. Please create a new profile.");
        return;
      }

      temp.search = {
        from_profile_id: active.profile_id,
        user_city: active.city,
        user_caste: active.caste,
        target_gender: targetGender,

        cityScope: null, // SAME_CITY / ANY
        ageMin: null,
        ageMax: null,
        casteScope: null, // SAME_CASTE / ANY
        eduMinRank: null, // null / 2 / 3
        incomeMin: null, // number
        results: [],
        page: 0,
      };

      await setState(from, "SEARCH_CITY_SCOPE", temp);
      await sendText(
        from,
        `Search preferences:\n1) Same City (${active.city})\n2) Any City in Maharashtra\n\nReply 1 or 2`
      );
      return;
    }

    // NEXT / PREV for search results
    if (cmd === "NEXT" || cmd === "PREV") {
      if (!temp.search || !Array.isArray(temp.search.results)) {
        await sendText(from, "Type *MATCHES* to start searching.");
        return;
      }
      const total = temp.search.results.length;
      if (!total) {
        await sendText(from, "No search results. Type *MATCHES* to search again.");
        return;
      }

      const maxPage = Math.floor((total - 1) / RESULTS_PAGE_SIZE);
      let page = temp.search.page || 0;
      page = cmd === "NEXT" ? Math.min(maxPage, page + 1) : Math.max(0, page - 1);
      temp.search.page = page;

      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    // DETAILS MH-XXXX
    if (cmd === "DETAILS") {
      const profileId = args[0];
      if (!profileId) {
        await sendText(from, "Use: DETAILS MH-XXXX");
        return;
      }

      const profiles = await findProfilesByPhone(from);
      const active = getLatestApprovedProfile(profiles);
      if (!active) {
        await sendText(from, "⏳ Your profile is not approved yet. Please wait for approval to view details.");
        return;
      }

      const used = await countThisMonth({ from_profile_id: active.profile_id, type: "DETAILS" });
      if (used >= MAX_DETAILS_PER_MONTH) {
        await sendText(from, `⚠️ Monthly limit reached: max ${MAX_DETAILS_PER_MONTH} details per month.`);
        return;
      }

      const target = await findProfileById(profileId);
      if (!target || target.status !== "APPROVED") {
        await sendText(from, "Profile not found / not approved.");
        return;
      }

      await appendRequest({
        from_profile_id: active.profile_id,
        to_profile_id: target.profile_id,
        status: "SENT",
        type: "DETAILS",
        viewer_phone: from,
      });

      const age = calcAgeFromDobDDMMYYYY(target.date_of_birth);
      const cap =
`📄 Profile Details
ID: ${target.profile_id}
Name: ${target.name} ${target.surname}
Gender: ${target.gender}
Age: ${age !== null ? age : "NA"}
City: ${target.city}, ${target.district}
Religion: ${target.religion}
Caste: ${target.caste}
Height: ${target.height}
Education: ${target.education}
Job: ${target.job}
Income: ${target.income_annual}

If interested: INTEREST ${target.profile_id}`;

      if (target.photo_url) {
        await sendImageByLink(from, target.photo_url, cap);
      } else {
        await sendText(from, cap + "\n\n(No photo available)");
      }
      return;
    }

    // INTEREST MH-XXXX
    if (cmd === "INTEREST") {
      const profileId = args[0];
      if (!profileId) {
        await sendText(from, "Use: INTEREST MH-XXXX");
        return;
      }

      const profiles = await findProfilesByPhone(from);
      const active = getLatestApprovedProfile(profiles);
      if (!active) {
        await sendText(from, "⏳ Your profile is not approved yet. Please wait for approval to send interest.");
        return;
      }

      const used = await countThisMonth({ from_profile_id: active.profile_id, type: "INTEREST" });
      if (used >= MAX_INTEREST_PER_MONTH) {
        await sendText(from, `⚠️ Monthly limit reached: max ${MAX_INTEREST_PER_MONTH} interests per month.`);
        return;
      }

      const target = await findProfileById(profileId);
      if (!target || target.status !== "APPROVED") {
        await sendText(from, "Profile not found / not approved.");
        return;
      }

      const existing = await findInterestRequest({ from_profile_id: active.profile_id, to_profile_id: target.profile_id });
      if (existing && ["SENT", "ACCEPTED"].includes(existing.status)) {
        await sendText(from, "You already showed interest in this profile.");
        return;
      }

      await appendRequest({
        from_profile_id: active.profile_id,
        to_profile_id: target.profile_id,
        status: "SENT",
        type: "INTEREST",
        viewer_phone: from,
      });

      await sendText(
        target.phone,
        `💌 Someone showed interest in you!\n\nInterested Profile ID: *${active.profile_id}*\n\nReply:\nACCEPT ${active.profile_id}\nREJECT ${active.profile_id}`
      );

      await sendText(from, `✅ Interest sent to ${target.profile_id}. You will be notified if they accept.`);
      return;
    }

    // ACCEPT / REJECT (receiver decides)
    if (cmd === "ACCEPT" || cmd === "REJECT") {
      const interestedProfileId = args[0];
      if (!interestedProfileId) {
        await sendText(from, "Use: ACCEPT MH-XXXX  OR  REJECT MH-XXXX");
        return;
      }

      const receiverProfiles = await findProfilesByPhone(from);
      const receiverActive = getLatestApprovedProfile(receiverProfiles);
      if (!receiverActive) {
        await sendText(from, "Your profile is not approved. You cannot accept/reject interests yet.");
        return;
      }

      const rows = await getAllRequestsRows();
      let foundReq = null;
      for (let i = 1; i < rows.length; i++) {
        const r = requestRowToObj(rows[i], i + 1);
        if (
          r.type === "INTEREST" &&
          r.from_profile_id === interestedProfileId &&
          r.to_profile_id === receiverActive.profile_id &&
          r.status === "SENT"
        ) {
          foundReq = r;
          break;
        }
      }

      if (!foundReq) {
        await sendText(from, "No pending interest found for this Profile ID.");
        return;
      }

      const newStatus = cmd === "ACCEPT" ? "ACCEPTED" : "REJECTED";
      await updateRequestStatus(foundReq.rowIndex, newStatus);

      const senderProfile = await findProfileById(interestedProfileId);
      if (!senderProfile) {
        await sendText(from, "Interest processed, but sender profile not found.");
        return;
      }

      if (cmd === "REJECT") {
        await sendText(from, `❌ Rejected interest from ${interestedProfileId}.`);
        await sendText(senderProfile.phone, `❌ Your interest was rejected by ${receiverActive.profile_id}.`);
        return;
      }

      await sendText(from, `✅ Accepted interest from ${interestedProfileId}.\nWe are sharing contact details now.`);

      await sendText(
        from,
        `📞 Contact shared:\nProfile: ${interestedProfileId}\nPhone: ${senderProfile.phone}`
      );

      await sendText(
        senderProfile.phone,
        `✅ Your interest was accepted!\n\n📞 Contact shared:\nProfile: ${receiverActive.profile_id}\nPhone: ${receiverActive.phone}`
      );

      return;
    }

    // ===================== SEARCH STEPS (guided filters) =====================
    if (st.step === "SEARCH_CITY_SCOPE") {
      if (!text) return;
      if (text !== "1" && text !== "2") {
        await sendText(from, "Reply 1 (Same City) or 2 (Any City)");
        return;
      }
      temp.search.cityScope = text === "1" ? "SAME_CITY" : "ANY";

      await setState(from, "SEARCH_AGE_RANGE", temp);
      await sendText(from, "Preferred age range? Example: 23-30\nType SKIP for default (±3 years).");
      return;
    }

    if (st.step === "SEARCH_AGE_RANGE") {
      if (!text) return;

      if (text.toUpperCase() === "SKIP") {
        temp.search.ageMin = 21;
        temp.search.ageMax = 35;
      } else {
        const m = text.match(/^(\d{2})-(\d{2})$/);
        if (!m) {
          await sendText(from, "Send age range like 23-30 or type SKIP.");
          return;
        }
        const a1 = parseInt(m[1], 10);
        const a2 = parseInt(m[2], 10);
        if (!a1 || !a2 || a1 < MIN_AGE || a2 < MIN_AGE || a1 > a2) {
          await sendText(from, `Age range invalid. Must be >=${MIN_AGE}. Example: 23-30`);
          return;
        }
        temp.search.ageMin = a1;
        temp.search.ageMax = a2;
      }

      await setState(from, "SEARCH_CASTE_SCOPE", temp);
      await sendText(from, `Caste preference?\n1) Same caste (${temp.search.user_caste || "your caste"})\n2) Any caste\nReply 1 or 2`);
      return;
    }

    if (st.step === "SEARCH_CASTE_SCOPE") {
      if (!text) return;
      if (text !== "1" && text !== "2") {
        await sendText(from, "Reply 1 (Same caste) or 2 (Any caste)");
        return;
      }
      temp.search.casteScope = text === "1" ? "SAME_CASTE" : "ANY";

      await setState(from, "SEARCH_EDU_MIN", temp);
      await sendText(from, "Minimum education?\n1) Any\n2) Graduate\n3) Postgraduate\nReply 1/2/3");
      return;
    }

    if (st.step === "SEARCH_EDU_MIN") {
      if (!text) return;
      if (!["1", "2", "3"].includes(text)) {
        await sendText(from, "Reply 1/2/3 only.");
        return;
      }
      temp.search.eduMinRank = text === "1" ? null : text === "2" ? 2 : 3;

      await setState(from, "SEARCH_INCOME_MIN", temp);
      await sendText(from, "Minimum income (LPA)? Example: 5\nType SKIP for any.");
      return;
    }

    if (st.step === "SEARCH_INCOME_MIN") {
      if (!text) return;
      if (text.toUpperCase() === "SKIP") {
        temp.search.incomeMin = null;
      } else {
        const v = parseFloat(text);
        if (Number.isNaN(v) || v < 0) {
          await sendText(from, "Send a number like 5 or type SKIP.");
          return;
        }
        temp.search.incomeMin = v;
      }

      const allRows = await getAllProfilesRows();
      const allProfiles = [];
      for (let i = 1; i < allRows.length; i++) {
        allProfiles.push(profileRowToObj(allRows[i], i + 1));
      }

      const results = applyFiltersToApprovedProfiles(allProfiles, {
        targetGender: temp.search.target_gender,
        cityScope: temp.search.cityScope,
        userCity: temp.search.user_city,
        ageMin: temp.search.ageMin,
        ageMax: temp.search.ageMax,
        casteScope: temp.search.casteScope,
        userCaste: temp.search.user_caste,
        eduMinRank: temp.search.eduMinRank,
        incomeMin: temp.search.incomeMin,
      });

      temp.search.results = results;
      temp.search.page = 0;

      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    // ===================== REGISTRATION FLOW (JOIN/NEWPROFILE) =====================
    if (text && (cmd === "JOIN" || cmd === "NEWPROFILE")) {
      const existing = await findProfilesByPhone(from);
      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        const lines = existing.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`).join("\n");
        await sendText(
          from,
          `⚠️ You already have ${existing.length} profiles (max ${MAX_PROFILES_PER_PHONE}).\n\n${lines}\n\nDelete one first:\nDELETE MH-XXXX\nOr type MYPROFILES`
        );
        return;
      }

      await setState(from, "ASK_NAME", {});
      // ✅ Brand welcome message only here (per your instruction)
      await sendText(
        from,
        `🌸 *${BRAND_NAME}*
${BRAND_WELCOME_LINE}
${BRAND_TAGLINE}

Reply with your *Name*:`
      );
      return;
    }

    // If no step and not a command, guide
    if (!st.step) {
      if (text) await sendText(from, "Type *JOIN* to create your profile.\nType *MATCHES* after approval to browse.");
      return;
    }

    // ---- Registration Steps (text based) ----
    if (st.step === "ASK_NAME") {
      if (!text) return;
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, "Good. Now reply with your *Surname*:");
      return;
    }

    if (st.step === "ASK_SURNAME") {
      if (!text) return;
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendText(from, "Gender? Reply *Male* or *Female*:");
      return;
    }

    if (st.step === "ASK_GENDER") {
      if (!text) return;
      const g = text.toLowerCase();
      if (!(g === "male" || g === "female")) {
        await sendText(from, "Please reply only *Male* or *Female*:");
        return;
      }
      temp.gender = g;
      await setState(from, "ASK_DOB", temp);
      await sendText(from, "Date of Birth? Format: *DD-MM-YYYY* (example 05-11-1998)");
      return;
    }

    if (st.step === "ASK_DOB") {
      if (!text) return;
      const age = calcAgeFromDobDDMMYYYY(text);
      if (age === null) {
        await sendText(from, "Please send DOB in *DD-MM-YYYY* format (example 05-11-1998)");
        return;
      }
      if (age < MIN_AGE) {
        await setState(from, "", {});
        await sendText(from, `❌ Registration not allowed. Minimum age is ${MIN_AGE} years.`);
        return;
      }
      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, "Height? (Example: 5'6 or 168 cm):");
      return;
    }

    if (st.step === "ASK_HEIGHT") {
      if (!text) return;
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, "Religion? (Example: Hindu / Muslim / Jain / Buddhist):");
      return;
    }

    if (st.step === "ASK_RELIGION") {
      if (!text) return;
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, "Caste? (Example: Maratha / Brahmin / Kunbi / etc.):");
      return;
    }

    if (st.step === "ASK_CASTE") {
      if (!text) return;
      temp.caste = text;
      await setState(from, "ASK_CITY", temp);
      await sendText(from, "City? (Maharashtra only) Example: Pune / Nashik / Mumbai:");
      return;
    }

    if (st.step === "ASK_CITY") {
      if (!text) return;
      temp.city = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, "District? Example: Pune / Nashik / Mumbai Suburban:");
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      if (!text) return;
      temp.district = text;
      await setState(from, "ASK_EDU", temp);
      await sendText(from, "Education? (Example: B.Com / BE / MBA):");
      return;
    }

    if (st.step === "ASK_EDU") {
      if (!text) return;
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendText(from, "Job/Business? (Example: Engineer / Business / Govt Job):");
      return;
    }

    if (st.step === "ASK_JOB") {
      if (!text) return;
      temp.job = text;
      await setState(from, "ASK_INCOME", temp);
      await sendText(from, "Annual Income? (Example: 5 LPA / 10 LPA / 15 LPA):");
      return;
    }

    if (st.step === "ASK_INCOME") {
      if (!text) return;
      temp.income_annual = text;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, "Please send *one clear photo* (selfie or portrait). Photo is mandatory ✅");
      return;
    }

    // ---- Photo step (image based) ----
    if (st.step === "ASK_PHOTO") {
      if (msgType !== "image") {
        await sendText(from, "Please send a *PHOTO* (not text). Photo is mandatory ✅");
        return;
      }
      const mediaId = msg.image?.id;
      if (!mediaId) {
        await sendText(from, "Photo not received properly. Please send again.");
        return;
      }

      const metaUrl = await getMetaMediaUrl(mediaId);
      if (!metaUrl) {
        await sendText(from, "Could not read photo. Please send again.");
        return;
      }

      let permanentLink = "";
      try {
        const { bytes, contentType } = await downloadMetaMediaBytes(metaUrl);
        const filename = `MH_${from}_${Date.now()}.jpg`;
        permanentLink = await uploadPhotoToDrive(bytes, contentType, filename);
      } catch (e) {
        console.error("Drive upload error:", e?.response?.data || e.message);
      }

      if (!permanentLink) {
        await sendText(from, "Photo upload failed. Please send photo again after some time.");
        return;
      }

      temp.photo_url = permanentLink;

      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);

      await setState(from, "", {});

      await sendText(
        from,
        `✅ Registration completed!\nYour Profile ID: *${profileId}*\n\nStatus: *PENDING approval*.\nYou will get message within 24 hours after approval.`
      );
      return;
    }
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
  }
});

// ===================== Start Server =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
