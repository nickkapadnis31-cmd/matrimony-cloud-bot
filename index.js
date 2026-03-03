// index.js — Navin Nati (नवीन नाती) Matrimony Bot
// Meta WhatsApp Cloud API + Google Sheets + Google Drive (Permanent Photos)
//
// Tabs in Google Sheet:
// 1) profiles  (A:Q) + optional extra columns after Q
// 2) state     (A:D)
// 3) requests  (A:E)
//
// Key features:
// - JOIN behaves like NEWPROFILE
// - Minimum age 18 (DOB validation)
// - Limit 2 profiles per phone (force delete first)
// - Admin approval: "approve MH-XXXX" (admin only)
// - Permanent photo storage to Google Drive (public link used to send photo on WhatsApp)
// - Search approved profiles only, opposite gender
// - DETAILS quota: max 5 per month (tracked in requests sheet)
// - INTEREST notification to target profile owner
//
// Env required:
// VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON, ADMIN_PHONE
// GOOGLE_DRIVE_FOLDER_ID (recommended for permanent photo storage)

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const { Readable } = require("stream");

const app = express();
app.use(express.json());

// ===================== BRAND =====================
const BRAND_NAME = "Navin Nati (नवीन नाती)";
const BRAND_TAGLINE = "Matrimony Maharashtra";

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const ADMIN_PHONE = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

// ===================== CONSTANTS =====================
const MAX_PROFILES_PER_PHONE = 2;
const MAX_DETAILS_PER_MONTH = 5;
const RESULTS_PAGE_SIZE = 5;

// Sheet names (must match exactly)
const SHEET_PROFILES = "profiles";
const SHEET_STATE = "state";
const SHEET_REQUESTS = "requests";

// Columns in profiles sheet (A:Q)
const COL_PROFILE_ID = 0;   // A
const COL_PHONE = 1;        // B
const COL_NAME = 2;         // C
const COL_SURNAME = 3;      // D
const COL_GENDER = 4;       // E
const COL_DOB = 5;          // F
const COL_HEIGHT = 6;       // G
const COL_RELIGION = 7;     // H
const COL_CASTE = 8;        // I
const COL_CITY = 9;         // J
const COL_DISTRICT = 10;    // K
const COL_EDU = 11;         // L
const COL_JOB = 12;         // M
const COL_INCOME = 13;      // N
const COL_PHOTO_URL = 14;   // O  (we will store Google Drive direct-download link here)
const COL_STATUS = 15;      // P  (PENDING / APPROVED / REJECTED / DELETED)
const COL_CREATED_AT = 16;  // Q

// Optional extra columns after Q (recommended but not mandatory):
// R: photo_drive_file_id, S: deleted_at, T: updated_at
const COL_PHOTO_DRIVE_FILE_ID = 17; // R (optional)
const COL_DELETED_AT = 18;          // S (optional)
const COL_UPDATED_AT = 19;          // T (optional)

// ===================== HELPERS =====================
function normalizePhone(p) {
  return (p || "").toString().replace(/\D/g, "");
}
function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}
function nowIso() {
  return new Date().toISOString();
}
function safeUpper(s) {
  return (s || "").toString().trim().toUpperCase();
}
function safeLower(s) {
  return (s || "").toString().trim().toLowerCase();
}
function buildDriveDirectLink(fileId) {
  // Works for WhatsApp Cloud API "image.link" in most cases
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// Parse DD-MM-YYYY and return {date, age} or null
function parseDobAndAge(dobText) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((dobText || "").trim());
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (yyyy < 1900 || yyyy > 2100) return null;
  if (mm < 1 || mm > 12) return null;
  if (dd < 1 || dd > 31) return null;

  // Create UTC date to avoid timezone issues
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  // Validate exact match (e.g. 31-02 invalid)
  if (d.getUTCFullYear() !== yyyy || d.getUTCMonth() !== (mm - 1) || d.getUTCDate() !== dd) return null;

  const today = new Date();
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (d > t) return null;

  // Age
  let age = t.getUTCFullYear() - d.getUTCFullYear();
  const mDiff = t.getUTCMonth() - d.getUTCMonth();
  if (mDiff < 0 || (mDiff === 0 && t.getUTCDate() < d.getUTCDate())) age--;

  return { date: d, age };
}

// ===================== GOOGLE CLIENTS =====================
function getGoogleAuth(scopes) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  const credentials = JSON.parse(raw);
  return new GoogleAuth({ credentials, scopes });
}

async function getSheetsClient() {
  const auth = getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets"]);
  return google.sheets({ version: "v4", auth });
}

async function getDriveClient() {
  const auth = getGoogleAuth(["https://www.googleapis.com/auth/drive"]);
  return google.drive({ version: "v3", auth });
}

// ===================== WHATSAPP CLOUD API =====================
async function waSendText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function waSendImage(to, link, caption = "") {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: caption ? { link, caption } : { link },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// ===================== SHEETS: STATE =====================
async function getState(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_STATE}!A:D`,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const [p, step, temp_data] = rows[i];
    if (p === phone) return { step: step || "", temp_data: temp_data || "{}" };
  }
  return { step: "", temp_data: "{}" };
}

async function setState(phone, step, tempObj) {
  const sheets = await getSheetsClient();
  const temp_data = JSON.stringify(tempObj || {});
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_STATE}!A:D`,
  });
  const rows = res.data.values || [];
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone) {
      rowIndex = i + 1;
      break;
    }
  }

  const values = [[phone, step, temp_data, nowIso()]];
  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_STATE}!A:D`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_STATE}!A${rowIndex}:D${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values },
    });
  }
}

// ===================== SHEETS: PROFILES =====================
async function readAllProfiles() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_PROFILES}!A:Z`,
  });
  return res.data.values || [];
}

function isActiveProfileRow(row) {
  const status = safeUpper(row[COL_STATUS] || "");
  return status !== "DELETED";
}

function isApprovedProfileRow(row) {
  const status = safeUpper(row[COL_STATUS] || "");
  return status === "APPROVED";
}

async function findProfilesByPhone(phone) {
  const rows = await readAllProfiles();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (normalizePhone(r[COL_PHONE]) === normalizePhone(phone) && isActiveProfileRow(r)) {
      out.push({ rowIndex: i + 1, row: r, profile_id: r[COL_PROFILE_ID] });
    }
  }
  return out;
}

async function findProfileById(profileId) {
  const rows = await readAllProfiles();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if ((r[COL_PROFILE_ID] || "") === profileId) {
      return { rowIndex: i + 1, row: r };
    }
  }
  return null;
}

async function updateProfileCell(rowIndex, a1, value) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_PROFILES}!${a1}${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

async function updateProfileCellsRow(rowIndex, valuesRow, fromColLetter, toColLetter) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_PROFILES}!${fromColLetter}${rowIndex}:${toColLetter}${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [valuesRow] },
  });
}

async function createProfile(phone, temp) {
  const sheets = await getSheetsClient();
  const profile_id = `MH-${String(Math.floor(1000 + Math.random() * 9000))}`;
  const row = [
    profile_id,
    phone,
    temp.name || "",
    temp.surname || "",
    temp.gender || "",
    temp.date_of_birth || "",
    temp.height || "",
    temp.religion || "",
    temp.caste || "",
    temp.city || "",
    temp.district || "",
    temp.education || "",
    temp.job || "",
    temp.income_annual || "",
    temp.photo_url || "",     // O
    "PENDING",                // P
    nowIso(),                 // Q
    temp.photo_drive_file_id || "", // R (optional)
    "",                            // S deleted_at (optional)
    nowIso(),                      // T updated_at (optional)
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_PROFILES}!A:T`, // allow optional columns
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  return profile_id;
}

async function markProfileDeleted(profileId, deletedBy) {
  const found = await findProfileById(profileId);
  if (!found) return { ok: false, reason: "Profile not found." };

  const rowIndex = found.rowIndex;
  await updateProfileCell(rowIndex, "P", "DELETED");
  // optional: deleted_at in S
  await updateProfileCell(rowIndex, "S", nowIso());
  // optional: updated_at in T
  await updateProfileCell(rowIndex, "T", nowIso());

  // Also clear state if this profile was selected later (handled at runtime)
  return { ok: true, phone: found.row[COL_PHONE] || "", rowIndex };
}

// ===================== SHEETS: REQUESTS (for INTEREST + DETAILS quota) =====================
async function appendRequest(req_id, from_profile_id, to_profile_id, status) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_REQUESTS}!A:E`,
    valueInputOption: "RAW",
    requestBody: { values: [[req_id, from_profile_id, to_profile_id, status, nowIso()]] },
  });
}

function monthKeyUTC(d = new Date()) {
  // YYYY-MM
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function countRequestsThisMonth(from_profile_id, status) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_REQUESTS}!A:E`,
  });
  const rows = res.data.values || [];
  const key = monthKeyUTC(new Date());
  let count = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rp = r[1] || "";
    const st = safeUpper(r[3] || "");
    const created = r[4] || "";
    if (rp === from_profile_id && st === safeUpper(status) && created.startsWith(key)) {
      count++;
    }
  }
  return count;
}

// ===================== DRIVE: PERMANENT PHOTO STORAGE =====================
async function downloadWhatsAppMediaAsBuffer(mediaId) {
  // 1) Get media URL
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const url = meta.data?.url;
  const mime = meta.data?.mime_type || "image/jpeg";
  if (!url) throw new Error("Could not fetch media URL from Meta");

  // 2) Download bytes (requires Authorization header)
  const fileRes = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });

  const buffer = Buffer.from(fileRes.data);
  return { buffer, mime };
}

async function uploadBufferToDrive(buffer, mimeType, fileName) {
  if (!DRIVE_FOLDER_ID) {
    throw new Error("Missing GOOGLE_DRIVE_FOLDER_ID env var");
  }
  const drive = await getDriveClient();

  // Upload
  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType,
      body: Readable.from(buffer), // IMPORTANT: stream for googleapis
    },
    fields: "id, webViewLink",
  });

  const fileId = created.data.id;
  if (!fileId) throw new Error("Drive upload failed: missing file id");

  // Make it accessible by link (so WhatsApp can fetch it)
  // NOTE: If you want more privacy, remove this and instead store only fileId for admin use.
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });

  // Return direct download link
  return { fileId, directLink: buildDriveDirectLink(fileId), webViewLink: created.data.webViewLink || "" };
}

// ===================== ADMIN NOTIFY =====================
async function notifyAdminNewProfile(profileId, from, temp) {
  if (!ADMIN_PHONE) return;

  const msg =
`🆕 New Registration (PENDING)

Profile ID: ${profileId}
Phone: ${from}
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
🗑️ Delete: delete ${profileId}`;

  await waSendText(ADMIN_PHONE, msg);

  // If we have a Drive photo link, also send photo to admin directly
  if (temp?.photo_url) {
    try {
      await waSendImage(ADMIN_PHONE, temp.photo_url, `📸 Photo of ${profileId}`);
    } catch (e) {
      // ignore image send failures
    }
  }
}

// ===================== SEARCH =====================
function profileRowToSummary(row) {
  const id = row[COL_PROFILE_ID] || "";
  const name = `${row[COL_NAME] || ""} ${row[COL_SURNAME] || ""}`.trim();
  const gender = row[COL_GENDER] || "";
  const city = row[COL_CITY] || "";
  const district = row[COL_DISTRICT] || "";
  const caste = row[COL_CASTE] || "";
  const edu = row[COL_EDU] || "";
  const job = row[COL_JOB] || "";
  const income = row[COL_INCOME] || "";
  return { id, name, gender, city, district, caste, edu, job, income };
}

function summaryLine(s) {
  return `• ${s.id} — ${s.name} (${s.city}, ${s.district}) | ${s.caste} | ${s.edu} | ${s.job} | ${s.income}`;
}

async function runSearch(activeProfileRow, criteria) {
  // activeProfileRow is row array of the searching profile
  const myGender = safeLower(activeProfileRow[COL_GENDER] || "");
  const wantGender = myGender === "male" ? "female" : myGender === "female" ? "male" : "";
  const rows = await readAllProfiles();

  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!isActiveProfileRow(r)) continue;
    if (!isApprovedProfileRow(r)) continue;
    if (safeLower(r[COL_GENDER] || "") !== wantGender) continue;

    // Basic filters
    if (criteria.city && safeLower(r[COL_CITY] || "") !== safeLower(criteria.city)) continue;
    if (criteria.district && safeLower(r[COL_DISTRICT] || "") !== safeLower(criteria.district)) continue;
    if (criteria.caste && safeLower(r[COL_CASTE] || "") !== safeLower(criteria.caste)) continue;

    // Age filter: compute from DOB if present
    if (criteria.minAge || criteria.maxAge) {
      const dob = r[COL_DOB] || "";
      const parsed = parseDobAndAge(dob);
      if (!parsed) continue; // if DOB invalid, skip
      if (criteria.minAge && parsed.age < criteria.minAge) continue;
      if (criteria.maxAge && parsed.age > criteria.maxAge) continue;
    }

    results.push(r);
  }

  // Simple sort: newest first
  results.sort((a, b) => (b[COL_CREATED_AT] || "").localeCompare(a[COL_CREATED_AT] || ""));
  return results;
}

async function sendResultsPage(to, temp) {
  const page = temp?.search?.page || 0;
  const ids = temp?.search?.results || [];
  const start = page * RESULTS_PAGE_SIZE;
  const end = start + RESULTS_PAGE_SIZE;
  const slice = ids.slice(start, end);

  if (slice.length === 0) {
    await waSendText(to, "No more results.");
    return;
  }

  const rows = await readAllProfiles();
  const byId = new Map();
  for (let i = 1; i < rows.length; i++) {
    byId.set(rows[i][COL_PROFILE_ID], rows[i]);
  }

  const lines = [];
  for (const id of slice) {
    const r = byId.get(id);
    if (!r) continue;
    lines.push(summaryLine(profileRowToSummary(r)));
  }

  const msg =
`🔎 Search Results (Page ${page + 1})

${lines.join("\n")}

Commands:
NEXT  → next page
DETAILS <ID> → full details (max ${MAX_DETAILS_PER_MONTH}/month)
INTEREST <ID> → show interest`;
  await waSendText(to, msg);
}

// ===================== WEBHOOK VERIFY (GET) =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== WEBHOOK RECEIVE (POST) =====================
app.post("/webhook", async (req, res) => {
  // IMPORTANT: Respond 200 immediately (Meta expects quick response)
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body?.entry?.[0]?.changes?.[0]?.value) return;

    const value = body.entry[0].changes[0].value;
    const msg = value.messages?.[0];
    if (!msg) return;

    const from = normalizePhone(msg.from); // user number (no +)
    const text = (msg.text?.body || "").trim();
    const cmd = safeUpper(text.split(/\s+/)[0] || "");
    const arg1 = (text.split(/\s+/)[1] || "").trim();

    // ------------------ ADMIN COMMANDS ------------------
    if (cmd === "APPROVE") {
      if (!isAdmin(from)) {
        await waSendText(from, "❌ Only admin can approve profiles.");
        return;
      }
      const profileId = arg1;
      if (!profileId) {
        await waSendText(from, "Please send: approve MH-XXXX");
        return;
      }

      const found = await findProfileById(profileId);
      if (!found) {
        await waSendText(from, "Profile ID not found.");
        return;
      }

      await updateProfileCell(found.rowIndex, "P", "APPROVED");
      await updateProfileCell(found.rowIndex, "T", nowIso()); // updated_at optional
      const userPhone = normalizePhone(found.row[COL_PHONE]);

      await waSendText(userPhone, `🎉 Congratulations!\nYour Profile ID *${profileId}* has been APPROVED.\n\nType *SEARCH* to find matches.`);
      await waSendText(from, `✅ Profile ${profileId} approved successfully.`);
      return;
    }

    if (cmd === "DELETE") {
      const profileId = arg1;
      if (!profileId) {
        await waSendText(from, "Please send: delete MH-XXXX");
        return;
      }

      const found = await findProfileById(profileId);
      if (!found) {
        await waSendText(from, "Profile ID not found.");
        return;
      }

      const ownerPhone = normalizePhone(found.row[COL_PHONE]);

      // Admin can delete anyone; users can delete only their own profiles
      if (!isAdmin(from) && ownerPhone !== from) {
        await waSendText(from, "❌ You can delete only your own profiles.");
        return;
      }

      const del = await markProfileDeleted(profileId, from);
      if (!del.ok) {
        await waSendText(from, del.reason || "Delete failed.");
        return;
      }

      if (ownerPhone === from) {
        await waSendText(from, `🗑️ Deleted profile ${profileId}.\nYou can create a new one with *JOIN* or *NEWPROFILE*.`);
      } else {
        await waSendText(from, `🗑️ Deleted profile ${profileId}.`);
        await waSendText(ownerPhone, `🗑️ Your profile ${profileId} was deleted by admin.`);
      }
      return;
    }

    // ------------------ BASIC HELP / MENU ------------------
    if (cmd === "MENU" || cmd === "HELP") {
      await waSendText(
        from,
`👋 ${BRAND_NAME}
${BRAND_TAGLINE}

Commands:
JOIN / NEWPROFILE  → create profile
MYPROFILES         → list your profiles
USE <ID>           → select active profile
DELETE <ID>        → delete your profile
SEARCH             → find matches (approved only)
NEXT               → next search page
DETAILS <ID>       → full details (max ${MAX_DETAILS_PER_MONTH}/month)
INTEREST <ID>      → show interest`
      );
      return;
    }

    // ------------------ MYPROFILES ------------------
    if (cmd === "MYPROFILES") {
      const list = await findProfilesByPhone(from);
      if (list.length === 0) {
        await waSendText(from, "No profiles found. Type *JOIN* to create one.");
        return;
      }
      const lines = list.map(p => `• ${p.profile_id} — ${p.row[COL_NAME] || ""} ${p.row[COL_SURNAME] || ""} (${p.row[COL_STATUS] || "PENDING"})`);
      await waSendText(from, `Your profiles:\n\n${lines.join("\n")}\n\nSelect one: USE <ID>`);
      return;
    }

    // ------------------ USE (select active profile) ------------------
    if (cmd === "USE") {
      const profileId = arg1;
      if (!profileId) {
        await waSendText(from, "Send: USE MH-XXXX");
        return;
      }
      const found = await findProfileById(profileId);
      if (!found || !isActiveProfileRow(found.row)) {
        await waSendText(from, "Profile not found (or deleted).");
        return;
      }
      if (normalizePhone(found.row[COL_PHONE]) !== from) {
        await waSendText(from, "❌ You can select only your own profile.");
        return;
      }

      const st = await getState(from);
      const temp = JSON.parse(st.temp_data || "{}");
      temp.active_profile_id = profileId;
      await setState(from, st.step || "", temp);

      await waSendText(from, `✅ Active profile set: ${profileId}\nNow type *SEARCH* to find matches.`);
      return;
    }

    // ------------------ JOIN / NEWPROFILE ------------------
    if (cmd === "JOIN" || cmd === "NEWPROFILE") {
      // Enforce profile limit
      const existing = await findProfilesByPhone(from);
      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        const lines = existing
          .map(p => `• ${p.profile_id} — ${(p.row[COL_NAME] || "")} ${(p.row[COL_SURNAME] || "")} (${p.row[COL_STATUS] || "PENDING"})`)
          .join("\n");

        await waSendText(
          from,
`⚠️ You already have ${existing.length} profiles (max ${MAX_PROFILES_PER_PHONE}).

${lines}

Please delete one first:
DELETE <PROFILE_ID>`
        );
        return;
      }

      await setState(from, "ASK_NAME", {});
      await waSendText(from, `👋 ${BRAND_NAME}\n\nReply with your *Name*:`);      
      return;
    }

    // If no text and not image, ignore
    // (We still need to accept images in ASK_PHOTO)
    const st = await getState(from);
    let temp = {};
    try { temp = JSON.parse(st.temp_data || "{}"); } catch { temp = {}; }

    // If user typed SEARCH without selecting active profile, auto-pick if only 1 exists
    if (cmd === "SEARCH") {
      let activeId = temp.active_profile_id || "";
      if (!activeId) {
        const mine = await findProfilesByPhone(from);
        if (mine.length === 1) {
          activeId = mine[0].profile_id;
          temp.active_profile_id = activeId;
          await setState(from, st.step || "", temp);
        }
      }
      if (!activeId) {
        await waSendText(from, "Please select your profile first: MYPROFILES → USE <ID>");
        return;
      }

      const found = await findProfileById(activeId);
      if (!found || !isActiveProfileRow(found.row)) {
        await waSendText(from, "Active profile not found (or deleted). Use MYPROFILES.");
        return;
      }
      if (!isApprovedProfileRow(found.row)) {
        await waSendText(from, "Your profile is not approved yet. Please wait for admin approval.");
        return;
      }

      // Start search questions
      temp.search = { step: "ASK_CITY", criteria: {}, results: [], page: 0 };
      await setState(from, "SEARCH", temp);
      await waSendText(from, "Search: Which *City* are you looking for? (example: Nashik)");
      return;
    }

    // Pagination
    if (cmd === "NEXT") {
      if (st.step !== "SEARCH_RESULTS") {
        await waSendText(from, "No active search. Type SEARCH to start.");
        return;
      }
      temp.search.page = (temp.search.page || 0) + 1;
      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp);
      return;
    }

    // DETAILS <ID>
    if (cmd === "DETAILS") {
      const targetId = arg1;
      if (!targetId) {
        await waSendText(from, "Send: DETAILS MH-XXXX");
        return;
      }
      const activeId = temp.active_profile_id || "";
      if (!activeId) {
        await waSendText(from, "Select your profile first: MYPROFILES → USE <ID>");
        return;
      }

      const myProfile = await findProfileById(activeId);
      if (!myProfile || !isApprovedProfileRow(myProfile.row)) {
        await waSendText(from, "Your profile must be APPROVED to use search/details.");
        return;
      }

      const used = await countRequestsThisMonth(activeId, "DETAILS");
      if (used >= MAX_DETAILS_PER_MONTH) {
        await waSendText(from, `⚠️ Monthly limit reached: ${MAX_DETAILS_PER_MONTH} DETAILS per month.`);
        return;
      }

      const target = await findProfileById(targetId);
      if (!target || !isApprovedProfileRow(target.row) || !isActiveProfileRow(target.row)) {
        await waSendText(from, "Profile not found or not approved.");
        return;
      }

      // Opposite gender check
      const myG = safeLower(myProfile.row[COL_GENDER] || "");
      const tg = safeLower(target.row[COL_GENDER] || "");
      if ((myG === "male" && tg !== "female") || (myG === "female" && tg !== "male")) {
        await waSendText(from, "This profile is not an opposite-gender match.");
        return;
      }

      await appendRequest(`REQ-${Date.now()}`, activeId, targetId, "DETAILS");

      const r = target.row;
      const full =
`📄 Profile Details: ${targetId}

Name: ${(r[COL_NAME] || "")} ${(r[COL_SURNAME] || "")}
Gender: ${r[COL_GENDER] || ""}
DOB: ${r[COL_DOB] || ""}
Height: ${r[COL_HEIGHT] || ""}
Religion: ${r[COL_RELIGION] || ""}
Caste: ${r[COL_CASTE] || ""}
City: ${r[COL_CITY] || ""}, ${r[COL_DISTRICT] || ""}
Education: ${r[COL_EDU] || ""}
Job: ${r[COL_JOB] || ""}
Income: ${r[COL_INCOME] || ""}

To show interest: INTEREST ${targetId}`;

      await waSendText(from, full);

      const photo = r[COL_PHOTO_URL] || "";
      if (photo) {
        try { await waSendImage(from, photo, `📸 Photo: ${targetId}`); } catch {}
      }
      return;
    }

    // INTEREST <ID>
    if (cmd === "INTEREST") {
      const targetId = arg1;
      if (!targetId) {
        await waSendText(from, "Send: INTEREST MH-XXXX");
        return;
      }
      const activeId = temp.active_profile_id || "";
      if (!activeId) {
        await waSendText(from, "Select your profile first: MYPROFILES → USE <ID>");
        return;
      }

      const myProfile = await findProfileById(activeId);
      if (!myProfile || !isApprovedProfileRow(myProfile.row)) {
        await waSendText(from, "Your profile must be APPROVED to send interest.");
        return;
      }

      const target = await findProfileById(targetId);
      if (!target || !isApprovedProfileRow(target.row) || !isActiveProfileRow(target.row)) {
        await waSendText(from, "Profile not found or not approved.");
        return;
      }

      // Opposite gender check
      const myG = safeLower(myProfile.row[COL_GENDER] || "");
      const tg = safeLower(target.row[COL_GENDER] || "");
      if ((myG === "male" && tg !== "female") || (myG === "female" && tg !== "male")) {
        await waSendText(from, "This profile is not an opposite-gender match.");
        return;
      }

      await appendRequest(`REQ-${Date.now()}`, activeId, targetId, "INTEREST");
      await waSendText(from, `✅ Interest sent to ${targetId}.`);

      // Notify target owner
      const targetOwner = normalizePhone(target.row[COL_PHONE] || "");
      if (targetOwner) {
        await waSendText(
          targetOwner,
          `💌 Someone showed interest in you!\n\nInterested Profile ID: *${activeId}*\nFor details, type: DETAILS ${activeId}`
        );
      }
      return;
    }

    // ------------------ SEARCH FLOW (questions + results) ------------------
    if (st.step === "SEARCH") {
      const search = temp.search || {};
      const step = search.step || "";
      const criteria = search.criteria || {};

      if (!text) {
        await waSendText(from, "Please reply with text.");
        return;
      }

      if (step === "ASK_CITY") {
        criteria.city = text.trim();
        search.step = "ASK_DISTRICT";
        search.criteria = criteria;
        temp.search = search;
        await setState(from, "SEARCH", temp);
        await waSendText(from, "District? (optional) Reply with district name OR type SKIP");
        return;
      }

      if (step === "ASK_DISTRICT") {
        if (safeUpper(text) !== "SKIP") criteria.district = text.trim();
        search.step = "ASK_CASTE";
        search.criteria = criteria;
        temp.search = search;
        await setState(from, "SEARCH", temp);
        await waSendText(from, "Caste? (optional) Reply caste name OR type SKIP");
        return;
      }

      if (step === "ASK_CASTE") {
        if (safeUpper(text) !== "SKIP") criteria.caste = text.trim();
        search.step = "ASK_MINAGE";
        search.criteria = criteria;
        temp.search = search;
        await setState(from, "SEARCH", temp);
        await waSendText(from, "Minimum Age? (example: 21) OR type SKIP");
        return;
      }

      if (step === "ASK_MINAGE") {
        if (safeUpper(text) !== "SKIP") {
          const n = Number(text);
          if (!Number.isFinite(n) || n < 18 || n > 80) {
            await waSendText(from, "Please enter a valid minimum age (18-80) or SKIP.");
            return;
          }
          criteria.minAge = Math.floor(n);
        }
        search.step = "ASK_MAXAGE";
        search.criteria = criteria;
        temp.search = search;
        await setState(from, "SEARCH", temp);
        await waSendText(from, "Maximum Age? (example: 30) OR type SKIP");
        return;
      }

      if (step === "ASK_MAXAGE") {
        if (safeUpper(text) !== "SKIP") {
          const n = Number(text);
          if (!Number.isFinite(n) || n < 18 || n > 80) {
            await waSendText(from, "Please enter a valid maximum age (18-80) or SKIP.");
            return;
          }
          criteria.maxAge = Math.floor(n);
        }

        // Run search
        const activeId = temp.active_profile_id || "";
        const myProfile = await findProfileById(activeId);
        if (!myProfile || !isApprovedProfileRow(myProfile.row)) {
          await waSendText(from, "Your profile must be APPROVED to search.");
          await setState(from, "", {});
          return;
        }

        const foundRows = await runSearch(myProfile.row, criteria);
        const ids = foundRows.map(r => r[COL_PROFILE_ID]).filter(Boolean);

        temp.search = { criteria, results: ids, page: 0 };
        await setState(from, "SEARCH_RESULTS", temp);

        if (ids.length === 0) {
          await waSendText(from, "No matches found with these filters. Type SEARCH to try again.");
          return;
        }

        await sendResultsPage(from, temp);
        return;
      }
    }

    // ------------------ REGISTRATION FLOW ------------------
    // Only proceed if user is in registration steps
    if (!st.step) {
      // If they typed something random, show help
      if (text) await waSendText(from, "Type *MENU* for commands. To create profile: *JOIN*");
      return;
    }

    if (st.step === "ASK_NAME") {
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await waSendText(from, "Now reply with your *Surname*:");
      return;
    }

    if (st.step === "ASK_SURNAME") {
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await waSendText(from, "Gender? Reply *Male* or *Female*:");
      return;
    }

    if (st.step === "ASK_GENDER") {
      const g = safeLower(text);
      if (!(g === "male" || g === "female")) {
        await waSendText(from, "Please reply only *Male* or *Female*:");
        return;
      }
      temp.gender = g;
      await setState(from, "ASK_DOB", temp);
      await waSendText(from, "Date of Birth? Format: *DD-MM-YYYY* (example 05-11-1998)");
      return;
    }

    if (st.step === "ASK_DOB") {
      const parsed = parseDobAndAge(text);
      if (!parsed) {
        await waSendText(from, "Invalid DOB. Please send in DD-MM-YYYY format (example 05-11-1998).");
        return;
      }
      if (parsed.age < 18) {
        await waSendText(from, "❌ Minimum age is 18. Registration not allowed.");
        await setState(from, "", {});
        return;
      }
      temp.date_of_birth = text.trim();
      await setState(from, "ASK_HEIGHT", temp);
      await waSendText(from, "Height? (Example: 5'6 or 168 cm):");
      return;
    }

    if (st.step === "ASK_HEIGHT") {
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await waSendText(from, "Religion? (Example: Hindu / Muslim / Jain / Buddhist):");
      return;
    }

    if (st.step === "ASK_RELIGION") {
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await waSendText(from, "Caste? (Example: Maratha / Brahmin / Kunbi / etc.):");
      return;
    }

    if (st.step === "ASK_CASTE") {
      temp.caste = text;
      await setState(from, "ASK_CITY", temp);
      await waSendText(from, "City? (Maharashtra only) Example: Pune / Nashik / Mumbai:");
      return;
    }

    if (st.step === "ASK_CITY") {
      temp.city = text;
      await setState(from, "ASK_DISTRICT", temp);
      await waSendText(from, "District? Example: Pune / Nashik / Mumbai Suburban:");
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      temp.district = text;
      await setState(from, "ASK_EDU", temp);
      await waSendText(from, "Education? (Example: B.Com / BE / MBA):");
      return;
    }

    if (st.step === "ASK_EDU") {
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await waSendText(from, "Job/Business? (Example: Engineer / Business / Govt Job):");
      return;
    }

    if (st.step === "ASK_JOB") {
      temp.job = text;
      await setState(from, "ASK_INCOME", temp);
      await waSendText(from, "Annual Income? (Example: 5 LPA / 10 LPA / 15 LPA):");
      return;
    }

    if (st.step === "ASK_INCOME") {
      temp.income_annual = text;
      await setState(from, "ASK_PHOTO", temp);
      await waSendText(from, "Please send *one clear photo* (selfie or portrait). Photo is mandatory ✅");
      return;
    }

    if (st.step === "ASK_PHOTO") {
      if (msg.type !== "image") {
        await waSendText(from, "Please send a *PHOTO* (not text). Photo is mandatory ✅");
        return;
      }
      const mediaId = msg.image?.id;
      if (!mediaId) {
        await waSendText(from, "Photo not received properly. Please send again.");
        return;
      }

      try {
        // Download from WhatsApp and upload to Drive
        const { buffer, mime } = await downloadWhatsAppMediaAsBuffer(mediaId);
        const fileName = `navin-nati_${from}_${Date.now()}.jpg`;
        const up = await uploadBufferToDrive(buffer, mime, fileName);

        temp.photo_drive_file_id = up.fileId;
        temp.photo_url = up.directLink; // store direct link in profiles O

      } catch (e) {
        console.error("Drive upload error:", e?.message || e);
        await waSendText(from, "Photo upload failed. Please send photo again after some time.");
        return;
      }

      // Create profile row in sheets
      const profileId = await createProfile(from, temp);

      // Set active profile automatically if none selected
      temp.active_profile_id = profileId;

      // Notify admin
      await notifyAdminNewProfile(profileId, from, temp);

      // Clear step but keep active_profile_id in temp for later
      await setState(from, "", { active_profile_id: profileId });

      await waSendText(
        from,
        `✅ Registration completed!\nYour Profile ID: *${profileId}*\n\nStatus: *PENDING approval*.\nYou will get a message after approval.`
      );
      return;
    }

    // Fallback
    await waSendText(from, "Type MENU for commands.");
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err?.message || err);
  }
});

// ===================== START SERVER =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
