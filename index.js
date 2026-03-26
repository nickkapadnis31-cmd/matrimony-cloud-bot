// index.js — Vivaho WhatsApp Matrimony Bot (Meta Cloud API + Google Sheets + Cloudinary)
//
// Brand: Vivaho
// Tagline: “नवीन नाती – विश्वासाने जोडलेली.”
//
// Profiles sheet columns A:U:
// A profile_id
// B phone
// C name
// D surname
// E gender
// F date_of_birth
// G religion
// H height
// I caste
// J native_place
// K district
// L work_city
// M work_district
// N education
// O job
// P job_title
// Q income_annual (stores monthly range text now if selected that way)
// R photo_url
// S status
// T created_at
// U marital_status

require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const cloudinary = require("cloudinary").v2;

const app = express();
app.use(express.json());

// ===================== Utils =====================
function normalizePhone(p) {
  return (p || "").toString().replace(/\D/g, "");
}

function nowISO() {
  return new Date().toISOString();
}

function monthKey(isoString = nowISO()) {
  return isoString.slice(0, 7);
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function parseCommand(text) {
  const parts = (text || "").trim().split(/\s+/);
  return { cmd: (parts[0] || "").toUpperCase(), args: parts.slice(1) };
}

function calcAgeFromDobDDMMYYYY(dob) {
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

function oppositeGender(g) {
  const x = (g || "").toLowerCase();
  if (x === "male") return "female";
  if (x === "female") return "male";
  return "";
}

function cleanLower(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizeProfileId(v) {
  return String(v || "").trim().toUpperCase();
}

function isValidProfileId(v) {
  return /^MH-\d{4,}$/.test(normalizeProfileId(v));
}

function normalizeGender(v) {
  const x = cleanLower(v);
  if (x === "male" || x === "m") return "male";
  if (x === "female" || x === "f") return "female";
  return "";
}

function isSkip(v) {
  return cleanUpper(v) === "SKIP";
}

function isSame(v) {
  return cleanUpper(v) === "SAME";
}

function maritalStatusFromInput(v) {
  const x = cleanLower(v);
  if (x.includes("unmarried") || x.includes("अविवाहित")) return "Unmarried";
  if (x.includes("divorce") || x.includes("घटस्फोट")) return "Divorce";
  if (x.includes("widower") || x.includes("widow") || x.includes("विधुर") || x.includes("विधवा")) return "Widower/Widow";
  return "";
}

function incomeBandRank(v) {
  const x = cleanLower(v || "");
  if (x.includes("above 3")) return 4;
  if (x.includes("1,00,000 to 3,00,000") || x.includes("1l - 3l")) return 3;
  if (x.includes("50,000 to 1,00,000") || x.includes("50k - 1l")) return 2;
  if (x.includes("up to 50,000")) return 1;
  return null;
}

function safeButtonTitle(s) {
  return String(s || "").slice(0, 20);
}

function safeListTitle(s) {
  return String(s || "").slice(0, 24);
}

function safeListDesc(s) {
  return String(s || "").slice(0, 72);
}

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || "");

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "";
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "";

if (!VERIFY_TOKEN || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !SHEET_ID) {
  console.warn("⚠️ Missing required env vars.");
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.warn("⚠️ Missing GOOGLE_SERVICE_ACCOUNT_JSON env var.");
}
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.warn("⚠️ Missing Cloudinary env vars.");
}

function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

// ===================== Branding / Constants =====================
const BRAND_NAME = "Vivaho";
const BRAND_SUBTITLE = "Matrimony Service";
const BRAND_TAGLINE = "नवीन नाती – विश्वासाने जोडलेली.";

const PROFILE_TAB = "profiles";
const STATE_TAB = "state";
const REQUESTS_TAB = "requests";

const MAX_PROFILES_PER_PHONE = 2;
const MIN_AGE = 18;
const MAX_DETAILS_PER_MONTH = 5;
const MAX_INTEREST_PER_MONTH = 5;
const RESULTS_PAGE_SIZE = 5;

// ===================== Messages =====================
const WELCOME_MSG =
`💍 *${BRAND_NAME}*
${BRAND_SUBTITLE}
${BRAND_TAGLINE}

Find the right match with trust ❤️
विश्वास के साथ सही life partner चुनिए ❤️`;

const COMMANDS_MSG =
`📘 *${BRAND_NAME} कैसे काम करता है / How it works*

*JOIN* → Create profile
प्रोफाइल बनाइए

*SEARCH* → Find matches
रिश्ते खोजिए

*DETAILS MH-XXXX* → Full profile info
पूरा प्रोफाइल देखें

*INTEREST MH-XXXX* → Show interest
रुचि दिखाएं

*MYPROFILES* → Your profiles
अपने प्रोफाइल देखें

*DELETE MH-XXXX* → Delete profile
प्रोफाइल हटाएं

*STOP* → Stop current process
चालू process रोकें

⏳ Only *APPROVED* profiles can use SEARCH / DETAILS / INTEREST
केवल *APPROVED* प्रोफाइल ही SEARCH / DETAILS / INTEREST का उपयोग कर सकते हैं`;

const THANK_YOU_MARKETING_MSG =
`🙏 Thank you for connecting with *${BRAND_NAME}*.

To find your life partner, message us again anytime ❤️
अपने मनपसंद life partner के लिए हमें फिर कभी भी message कीजिए ❤️

📩 Start anytime with *JOIN*
कभी भी *JOIN* से शुरू करें`;

const PENDING_MSG =
`💍 *${BRAND_NAME}*

Your profile is not approved yet.
आपका प्रोफाइल अभी approved नहीं हुआ है।

Please wait for admin approval.
Admin approval के बाद *SEARCH* भेजें।`;

function makeInvalidReplyMsg(originalPrompt) {
  return `❌ Invalid response.

Please choose the correct option or type *STOP*.
सही option चुनें या *STOP* टाइप करें।

${originalPrompt}`;
}

function getPromptByStep(step) {
  switch (step) {
    case "ASK_NAME":
      return "Please enter your Name\nकृपया अपना नाम लिखें";
    case "ASK_SURNAME":
      return "Please enter your Surname\nकृपया अपना surname लिखें";
    case "ASK_DOB":
      return "Enter Date of Birth\nजन्मतिथि लिखें\n\nFormat: *DD-MM-YYYY*\nExample: 05-11-1998";
    case "ASK_HEIGHT":
      return "Enter Height\nऊंचाई लिखें\n\nExample: 5'6 or 168 cm";
    case "ASK_RELIGION":
      return "Enter Religion\nधर्म लिखें\n\nExample: Hindu / Muslim / Jain / Buddhist";
    case "ASK_CASTE":
      return "Enter Caste\nजात लिखें";
    case "ASK_NATIVE_PLACE":
      return "Enter Native Place\nमूल गांव / Native Place लिखें";
    case "ASK_DISTRICT":
      return "Enter District\nजिला लिखें";
    case "ASK_WORK_CITY":
      return "Enter Work City\nकाम का शहर लिखें\n\nIf same as native place, type *SAME*";
    case "ASK_WORK_DISTRICT":
      return "Enter Work District\nकाम का जिला लिखें\n\nIf same as district, type *SAME*\nIf unknown, type *SKIP*";
    case "ASK_EDU":
      return "Enter Education\nशिक्षा लिखें\n\nExample: B.Com / BE / MBA";
    case "ASK_JOB_TITLE":
      return "Enter your Job Role\nआप क्या काम करते हैं?\n\nExample: Software Engineer / Teacher / Business Owner";
    case "ASK_PHOTO":
      return "Please send one clear photo 📸\nकृपया एक साफ फोटो भेजें";
    case "SEARCH_AGE_RANGE":
      return `Enter preferred age range
पसंदीदा उम्र सीमा लिखें

Example: 23-30
You can also skip using the button below 👇
या नीचे दिए गए button का उपयोग करके skip कर सकते हैं 👇`;
    default:
      return "";
  }
}

// ===================== Cloudinary =====================
cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET,
});

async function uploadPhotoToCloudinary(bytes, filename = "") {
  try {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

    return await new Promise((resolve) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: "vivaho_profiles",
          resource_type: "image",
          public_id: filename ? filename.replace(/\.[^/.]+$/, "") : undefined,
          overwrite: false,
        },
        (error, result) => {
          if (error) {
            console.error("Cloudinary upload error:", error);
            return resolve("");
          }
          resolve(result?.secure_url || "");
        }
      );

      uploadStream.end(buffer);
    });
  } catch (err) {
    console.error("Cloudinary error:", err?.message || err);
    return "";
  }
}

// ===================== Google Auth / Clients =====================
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  return new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function getSheetsClient() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

// ===================== WhatsApp Cloud API =====================
async function sendText(to, body) {
  const phone = normalizePhone(to);
  if (!phone) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  try {
    const resp = await axios.post(
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

    console.log("sendText success:", JSON.stringify(resp.data));
  } catch (err) {
    console.error("sendText failed:", JSON.stringify(err?.response?.data || err.message));
    throw err;
  }
}

async function sendImageByLink(to, imageLink, caption = "") {
  const phone = normalizePhone(to);
  if (!phone) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "image",
      image: { link: imageLink, ...(caption ? { caption } : {}) },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    }
  );
}

async function sendButtons(to, body, buttons) {
  const phone = normalizePhone(to);
  if (!phone || !Array.isArray(buttons) || buttons.length === 0 || buttons.length > 3) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: {
              id: String(b.id).slice(0, 256),
              title: safeButtonTitle(b.title),
            },
          })),
        },
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
}

async function sendList(to, body, buttonText, rows, sectionTitle = "Select") {
  const phone = normalizePhone(to);
  if (!phone || !Array.isArray(rows) || !rows.length) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: buttonText || "Select",
          sections: [
            {
              title: sectionTitle,
              rows: rows.map((r) => ({
                id: String(r.id).slice(0, 256),
                title: safeListTitle(r.title),
                ...(r.description ? { description: safeListDesc(r.description) } : {}),
              })),
            },
          ],
        },
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
}

async function sendProceedStopButtons(to) {
  await sendButtons(to, "Do you want to continue?\nक्या आप आगे बढ़ना चाहते हैं?", [
    { id: "PROCEED", title: "Proceed" },
    { id: "STOP", title: "Stop" },
  ]);
}

async function sendJoinStopButtons(to, body = "Choose an option\nकृपया एक option चुनें") {
  await sendButtons(to, body, [
    { id: "JOIN", title: "JOIN" },
    { id: "STOP", title: "STOP" },
  ]);
}

async function sendSearchButton(to, body) {
  await sendButtons(to, body, [{ id: "SEARCH", title: "SEARCH" }]);
}

async function sendSearchAgainButton(to, body) {
  await sendButtons(to, body, [{ id: "SEARCH_AGAIN", title: "Search Again" }]);
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

// ===================== Sheets: STATE =====================
async function getState(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${STATE_TAB}!A:D`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const [p, step, temp_data] = rows[i];
    if ((p || "") === phone) return { step: step || "", temp_data: temp_data || "{}" };
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
      rowIndex = i + 1;
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
async function getAllProfilesRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:U`,
  });
  return res.data.values || [];
}

function profileRowToObj(row, rowIndex1Based) {
  const obj = {
    rowIndex: rowIndex1Based,
    profile_id: row?.[0] || "",
    phone: row?.[1] || "",
    name: row?.[2] || "",
    surname: row?.[3] || "",
    gender: cleanLower(row?.[4] || ""),
    date_of_birth: row?.[5] || "",
    religion: row?.[6] || "",
    height: row?.[7] || "",
    caste: row?.[8] || "",
    native_place: row?.[9] || "",
    district: row?.[10] || "",
    work_city: row?.[11] || "",
    work_district: row?.[12] || "",
    education: row?.[13] || "",
    job: row?.[14] || "",
    job_title: row?.[15] || "",
    income_annual: row?.[16] || "",
    photo_url: row?.[17] || "",
    status: cleanUpper(row?.[18] || ""),
    created_at: row?.[19] || "",
    marital_status: row?.[20] || "",
  };

  obj.city = obj.native_place;
  return obj;
}

async function findProfilesByPhone(phone) {
  const rows = await getAllProfilesRows();
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = profileRowToObj(rows[i], i + 1);
    if (obj.phone === phone) list.push(obj);
  }
  return list;
}

async function findProfileById(profileId) {
  const targetId = normalizeProfileId(profileId);
  const rows = await getAllProfilesRows();
  for (let i = 1; i < rows.length; i++) {
    const obj = profileRowToObj(rows[i], i + 1);
    if (normalizeProfileId(obj.profile_id) === targetId) return obj;
  }
  return null;
}

async function updateProfileStatus(rowIndex1Based, newStatus) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!S${rowIndex1Based}`,
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
              startIndex: rowIndex1Based - 1,
              endIndex: rowIndex1Based,
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
    profile_id,                // A
    phone,                     // B
    temp.name || "",           // C
    temp.surname || "",        // D
    temp.gender || "",         // E
    temp.date_of_birth || "",  // F
    temp.religion || "",       // G
    temp.height || "",         // H
    temp.caste || "",          // I
    temp.native_place || "",   // J
    temp.district || "",       // K
    temp.work_city || "",      // L
    temp.work_district || "",  // M
    temp.education || "",      // N
    temp.job || "",            // O
    temp.job_title || "",      // P
    temp.income_annual || "",  // Q
    temp.photo_url || "",      // R
    "PENDING",                 // S
    createdAt,                 // T
    temp.marital_status || "", // U
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:U`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  return profile_id;
}

function getLatestApprovedProfile(profiles) {
  for (let i = profiles.length - 1; i >= 0; i--) {
    if (cleanUpper(profiles[i].status) === "APPROVED") return profiles[i];
  }
  return null;
}

// ===================== Sheets: REQUESTS =====================
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
    status: cleanUpper(row?.[3] || ""),
    created_at: row?.[4] || "",
    type: cleanUpper(row?.[5] || ""),
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
    range: `${REQUESTS_TAB}!D${rowIndex1Based}`,
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

💍 ${BRAND_NAME}
${BRAND_TAGLINE}

Profile ID: *${profileId}*
Phone: ${phone}

Name: ${temp?.name || ""} ${temp?.surname || ""}
Gender: ${temp?.gender || ""}
Marital Status: ${temp?.marital_status || ""}
DOB: ${temp?.date_of_birth || ""}
Height: ${temp?.height || ""}

Religion: ${temp?.religion || ""}
Caste: ${temp?.caste || ""}

Native Place: ${temp?.native_place || ""}, ${temp?.district || ""}
Work Location: ${temp?.work_city || ""}, ${temp?.work_district || ""}

Education: ${temp?.education || ""}
Job Type: ${temp?.job || ""}
Job Title: ${temp?.job_title || ""}
Income: ${temp?.income_annual || ""}

👇 Take action`;

  await sendText(ADMIN_PHONE, msg);
  await sendButtons(ADMIN_PHONE, `Action for ${profileId}`, [
    { id: `ADMIN_APPROVE_${profileId}`, title: "APPROVE" },
    { id: `ADMIN_REJECT_${profileId}`, title: "REJECT" },
  ]);
}

// ===================== Matching Helpers =====================
function educationRank(edu) {
  const e = (edu || "").toLowerCase();
  if (e.includes("phd") || e.includes("doctor")) return 4;
  if (e.includes("mba") || e.includes("mtech") || e.includes("ms") || e.includes("post")) return 3;
  if (e.includes("be") || e.includes("btech") || e.includes("b.") || e.includes("graduate")) return 2;
  return 1;
}

function buildProfileCardLine(p) {
  const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
  const ageTxt = age !== null ? `${age}` : "NA";
  const nativeTxt = p.native_place ? `${p.native_place}` : "NA";
  const workTxt = p.work_city ? `${p.work_city}` : "NA";
  const jobTitleTxt = p.job_title ? p.job_title : (p.job || "");

  return `• ${p.profile_id} | Age: ${ageTxt} | Native: ${nativeTxt} | Work: ${workTxt} | ${p.education} | ${jobTitleTxt}`;
}

function applyFiltersToApprovedProfiles(allProfiles, opts) {
  const out = [];

  for (const p of allProfiles) {
    if (cleanUpper(p.status) !== "APPROVED") continue;

    const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
    if (age === null || age < MIN_AGE) continue;

    if (opts.excludeProfileId && p.profile_id === opts.excludeProfileId) continue;
    if (opts.targetGender && cleanLower(p.gender) !== cleanLower(opts.targetGender)) continue;

    if (opts.cityScope === "SAME_CITY" && opts.userCity) {
      if (cleanLower(p.native_place) !== cleanLower(opts.userCity)) continue;
    }

    if (opts.workCityScope === "SAME_CITY" && opts.userWorkCity) {
      if (cleanLower(p.work_city) !== cleanLower(opts.userWorkCity)) continue;
    }

    if (opts.ageMin !== null && age < opts.ageMin) continue;
    if (opts.ageMax !== null && age > opts.ageMax) continue;

    if (opts.casteScope === "SAME_CASTE" && opts.userCaste) {
      if (cleanLower(p.caste) !== cleanLower(opts.userCaste)) continue;
    }

    if (opts.eduMinRank !== null) {
      if (educationRank(p.education) < opts.eduMinRank) continue;
    }

    if (opts.incomeMinRank !== null) {
      const rank = incomeBandRank(p.income_annual);
      if (rank === null || rank < opts.incomeMinRank) continue;
    }

    out.push(p);
  }

  return out;
}

function getSearchStateTemp(activeProfile) {
  return {
    from_profile_id: activeProfile.profile_id,
    user_city: activeProfile.native_place || activeProfile.city || "",
    user_caste: activeProfile.caste || "",
    user_work_city: activeProfile.work_city || "",
    target_gender: oppositeGender(activeProfile.gender),
    cityScope: null,
    workCityScope: null,
    ageMin: null,
    ageMax: null,
    casteScope: null,
    eduMinRank: null,
    incomeMinRank: null,
    results: [],
    page: 0,
    selected_profile_id: "",
  };
}

async function restartSearchFlow(from) {
  const profiles = await findProfilesByPhone(from);
  const active = getLatestApprovedProfile(profiles);

  if (!active) {
    await sendText(from, PENDING_MSG);
    return;
  }

  const targetGender = oppositeGender(active.gender);
  if (!targetGender) {
    await sendText(from, "Your gender is missing in profile.\nआपके प्रोफाइल में gender missing है।");
    return;
  }

  const temp = {};
  temp.search = getSearchStateTemp(active);

  await setState(from, "SEARCH_CITY_SCOPE", temp);
  await sendButtons(from, "Native place preference\nNative place के लिए preference चुनें", [
    { id: "SEARCH_NATIVE_SAME", title: "Same Native" },
    { id: "SEARCH_NATIVE_ANY", title: "Any Native" },
  ]);
}

async function sendResultsPage(to, searchState) {
  const { results = [], page = 0 } = searchState;

  if (!results.length) {
    await sendText(
      to,
      `💍 *${BRAND_NAME}*

No matches found.
कोई matching profile नहीं मिला।

You can try again with different preferences 👇
आप अलग preferences के साथ फिर से प्रयास कर सकते हैं 👇`
    );
    await sendSearchAgainButton(to, "Try search again\nफिर से search करें");
    return;
  }

  const start = page * RESULTS_PAGE_SIZE;
  const end = start + RESULTS_PAGE_SIZE;
  const chunk = results.slice(start, end);

  let msg = `💍 *${BRAND_NAME}*\n\n🔎 Matches (${start + 1}-${Math.min(end, results.length)} of ${results.length})\n\n`;
  msg += chunk.map(buildProfileCardLine).join("\n");
  msg += `\n\n👉 Select a Profile ID to continue
👉 आगे बढ़ने के लिए Profile ID चुनें`;

  await sendText(to, msg);

  if (results.length > RESULTS_PAGE_SIZE) {
    if (start === 0) {
      await sendButtons(to, "Choose an option\nकृपया option चुनें", [
        { id: "RESULT_NEXT", title: "NEXT" },
        { id: "SEARCH_AGAIN", title: "Search Again" },
      ]);
    } else if (end >= results.length) {
      await sendButtons(to, "Choose an option\nकृपया option चुनें", [
        { id: "RESULT_PREV", title: "PREV" },
        { id: "SEARCH_AGAIN", title: "Search Again" },
      ]);
    } else {
      await sendButtons(to, "Choose an option\nकृपया option चुनें", [
        { id: "RESULT_PREV", title: "PREV" },
        { id: "RESULT_NEXT", title: "NEXT" },
        { id: "SEARCH_AGAIN", title: "Search Again" },
      ]);
    }
  } else {
    await sendButtons(to, "Choose an option\nकृपया option चुनें", [
      { id: "SEARCH_AGAIN", title: "Search Again" },
    ]);
  }
}

async function sendSelectedProfileActions(to, profileId) {
  await sendText(
    to,
    `💍 *${BRAND_NAME}*

Profile *${profileId}* selected
आपने *${profileId}* प्रोफाइल चुना है

What would you like to do?
आप क्या करना चाहते हैं?`
  );

  await sendButtons(to, "Choose action\nAction चुनें", [
    { id: `SEL_DETAILS_${profileId}`, title: "DETAILS" },
    { id: `SEL_INTEREST_${profileId}`, title: "INTEREST" },
    { id: "SEL_BACK_LIST", title: "BACK TO LIST" },
  ]);
}

async function sendOwnProfileDetails(to, profileId) {
  const p = await findProfileById(profileId);
  if (!p) {
    await sendText(to, "Profile not found.");
    return;
  }
  if (p.phone !== normalizePhone(to)) {
    await sendText(to, "❌ You can view only your own profile here.");
    return;
  }

  const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
  const body =
`💍 *${BRAND_NAME}*

📄 Your Profile Details
आपकी प्रोफाइल जानकारी

ID: ${p.profile_id}
Gender: ${p.gender}
Marital Status: ${p.marital_status || "NA"}
Age: ${age !== null ? age : "NA"}

Native: ${p.native_place}, ${p.district}
Work: ${p.work_city}, ${p.work_district}

Religion: ${p.religion}
Caste: ${p.caste}
Height: ${p.height}

Education: ${p.education}
Job Type: ${p.job}
Job Title: ${p.job_title}
Income: ${p.income_annual}`;

  if (p.photo_url) {
    await sendImageByLink(to, p.photo_url, body);
  } else {
    await sendText(to, body);
  }
}

// ===================== Health =====================
app.get("/health", (req, res) => res.status(200).send("OK"));

// ===================== Webhook Verify =====================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===================== Webhook Receive =====================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = normalizePhone(msg.from);
    const msgType = msg.type;
    const text = (msg.text?.body || "").trim();
    const interactiveId =
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.id ||
      "";
    const interactiveTitle =
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      "";

    console.log("📩 Incoming Message:");
    console.log("From:", from);
    console.log("Type:", msgType);
    console.log("Text:", text);
    console.log("Interactive ID:", interactiveId);
    console.log("Interactive Title:", interactiveTitle);
    console.log("Full Payload:", JSON.stringify(msg, null, 2));

    const st = await getState(from);
    const temp = safeJsonParse(st.temp_data || "{}", {});
    const rawInput = text || interactiveId || "";
    const { cmd, args } = parseCommand(rawInput);

    // ===================== Global interactive shortcuts =====================

    if (interactiveId === "JOIN") {
      // continue into normal JOIN flow below
    }

    if (interactiveId === "SEARCH" || interactiveId === "SEARCH_AGAIN") {
      if (interactiveId === "SEARCH_AGAIN") {
        await sendText(
          from,
          `🔍 Starting new search...
Please select your preferences again
कृपया अपनी preferences फिर से चुनें`
        );
      }
      await restartSearchFlow(from);
      return;
    }

    if (interactiveId === "RESULT_NEXT") {
      if (!temp.search || !Array.isArray(temp.search.results)) {
        await sendText(from, "Type *SEARCH* to start searching.");
        return;
      }
      const total = temp.search.results.length;
      const maxPage = Math.floor((total - 1) / RESULTS_PAGE_SIZE);
      temp.search.page = Math.min(maxPage, (temp.search.page || 0) + 1);
      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    if (interactiveId === "RESULT_PREV") {
      if (!temp.search || !Array.isArray(temp.search.results)) {
        await sendText(from, "Type *SEARCH* to start searching.");
        return;
      }
      temp.search.page = Math.max(0, (temp.search.page || 0) - 1);
      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    if (interactiveId === "SEL_BACK_LIST") {
      if (!temp.search) {
        await sendText(from, "No active search list.");
        return;
      }
      temp.search.selected_profile_id = "";
      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    if (interactiveId.startsWith("SEL_DETAILS_")) {
      const profileId = normalizeProfileId(interactiveId.replace("SEL_DETAILS_", ""));
      // reuse existing details flow by setting typed command
      const typed = `DETAILS ${profileId}`;
      const parsed = parseCommand(typed);
      // emulate below by overwriting
      temp._forced_cmd = parsed.cmd;
      temp._forced_args = parsed.args;
    }

    if (interactiveId.startsWith("SEL_INTEREST_")) {
      const profileId = normalizeProfileId(interactiveId.replace("SEL_INTEREST_", ""));
      const typed = `INTEREST ${profileId}`;
      const parsed = parseCommand(typed);
      temp._forced_cmd = parsed.cmd;
      temp._forced_args = parsed.args;
    }

    if (interactiveId.startsWith("DEL_PROFILE_")) {
      const profileId = normalizeProfileId(interactiveId.replace("DEL_PROFILE_", ""));
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
      await sendText(from, `✅ Profile deleted successfully.
प्रोफाइल सफलतापूर्वक delete हो गया।

Deleted: *${profileId}*`);
      await sendJoinStopButtons(from, "What would you like to do next?\nअब आगे क्या करना है?");
      return;
    }

    if (interactiveId.startsWith("ADMIN_APPROVE_")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can approve.");
        return;
      }
      const profileId = normalizeProfileId(interactiveId.replace("ADMIN_APPROVE_", ""));
      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.");
        return;
      }
      await updateProfileStatus(prof.rowIndex, "APPROVED");

      await sendText(
        prof.phone,
        `🎉 Congratulations! / बधाई हो!

Your profile *${profileId}* is now *APPROVED*
आपका प्रोफाइल अब *APPROVED* हो गया है

💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

To search matches, click the button below 👇
अपने लिए सही जीवनसाथी ढूंढने के लिए नीचे दिए गए button पर click करें 👇`
      );
      await sendSearchButton(prof.phone, "Start searching\nरिश्ते ढूंढना शुरू करें");
      await sendText(from, `✅ Approved ${profileId}`);
      return;
    }

    if (interactiveId.startsWith("ADMIN_REJECT_")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can reject.");
        return;
      }
      const profileId = normalizeProfileId(interactiveId.replace("ADMIN_REJECT_", ""));
      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.");
        return;
      }
      await updateProfileStatus(prof.rowIndex, "REJECTED");

      await sendText(
        prof.phone,
        `❌ Your profile *${profileId}* was rejected.
आपका प्रोफाइल *${profileId}* reject कर दिया गया है।

💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

You can create a new profile after deleting this one.
इसे delete करने के बाद आप नया profile बना सकते हैं।`
      );
      await sendText(from, `✅ Rejected ${profileId}`);
      return;
    }

    if (interactiveId === "MYPROFILES_BTN") {
      const profiles = await findProfilesByPhone(from);
      if (!profiles.length) {
        await sendText(from, `${WELCOME_MSG}`);
        await sendJoinStopButtons(from);
        return;
      }

      const lines = profiles.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`);
      await sendText(
        from,
        `💍 *${BRAND_NAME}*

Your Profiles
आपके प्रोफाइल

${lines.join("\n")}

👉 Select a profile or choose an action below
👉 नीचे दिए गए options में से चुनें`
      );
      await sendButtons(from, "Choose action\nAction चुनें", [
        { id: "MYP_DELETE", title: "DELETE" },
        { id: "JOIN", title: "JOIN" },
        { id: "MYP_DETAILS", title: "DETAILS" },
      ]);
      return;
    }

    if (interactiveId === "MYP_DELETE") {
      const profiles = await findProfilesByPhone(from);
      if (!profiles.length) {
        await sendText(from, "No profiles found.");
        return;
      }
      await sendText(from, "Select profile to delete\nDelete करने के लिए profile चुनें");
      const buttons = profiles.slice(0, 2).map((p) => ({
        id: `DEL_PROFILE_${p.profile_id}`,
        title: p.profile_id,
      }));
      await sendButtons(from, "Tap a profile\nकिस profile को delete करना है?", buttons);
      return;
    }

    if (interactiveId === "MYP_DETAILS") {
      const profiles = await findProfilesByPhone(from);
      if (!profiles.length) {
        await sendText(from, "No profiles found.");
        return;
      }
      await sendText(from, "Select profile to view details\nDetails देखने के लिए profile चुनें");
      const buttons = profiles.slice(0, 2).map((p) => ({
        id: `OWN_DETAILS_${p.profile_id}`,
        title: p.profile_id,
      }));
      await sendButtons(from, "Tap a profile\nकौन सा profile देखना है?", buttons);
      return;
    }

    if (interactiveId.startsWith("OWN_DETAILS_")) {
      const profileId = normalizeProfileId(interactiveId.replace("OWN_DETAILS_", ""));
      await sendOwnProfileDetails(from, profileId);
      return;
    }

    if (interactiveId === "SKIP_AGE_RANGE") {
      temp.search.ageMin = 21;
      temp.search.ageMax = 40;
      await setState(from, "SEARCH_CASTE_SCOPE", temp);
      await sendButtons(from, "Caste preference\nजात preference चुनें", [
        { id: "SEARCH_CASTE_SAME", title: "Same Caste" },
        { id: "SEARCH_CASTE_ANY", title: "Any Caste" },
      ]);
      return;
    }

    // forced command handling from selected profile buttons
    let effectiveCmd = cmd;
    let effectiveArgs = args;
    if (temp._forced_cmd) {
      effectiveCmd = temp._forced_cmd;
      effectiveArgs = temp._forced_args || [];
      delete temp._forced_cmd;
      delete temp._forced_args;
    }

    // ===================== GLOBAL CANCEL =====================
    if (effectiveCmd === "STOP" || effectiveCmd === "CANCEL") {
      await setState(from, "", {});
      await sendText(from, `✅ Process stopped.
प्रक्रिया रोक दी गई।

${WELCOME_MSG}`);
      await sendJoinStopButtons(from);
      return;
    }

    // ===================== ADMIN typed APPROVE / REJECT =====================
    if (rawInput && (effectiveCmd === "APPROVE" || effectiveCmd === "REJECT")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can approve/reject profiles.");
        return;
      }

      const profileId = normalizeProfileId(effectiveArgs[0]);
      if (!profileId) {
        await sendText(from, "Use: approve MH-XXXX OR reject MH-XXXX");
        return;
      }

      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.");
        return;
      }

      const newStatus = effectiveCmd === "APPROVE" ? "APPROVED" : "REJECTED";
      await updateProfileStatus(prof.rowIndex, newStatus);

      if (effectiveCmd === "APPROVE") {
        await sendText(
          prof.phone,
          `🎉 Congratulations! / बधाई हो!

Your profile *${profileId}* is now *APPROVED*
आपका प्रोफाइल अब *APPROVED* हो गया है

💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

To search matches, click the button below 👇
अपने लिए सही जीवनसाथी ढूंढने के लिए नीचे दिए गए button पर click करें 👇`
        );
        await sendSearchButton(prof.phone, "Start searching\nरिश्ते ढूंढें");
        await sendText(from, `✅ Approved ${profileId}`);
      } else {
        await sendText(
          prof.phone,
          `❌ Your profile *${profileId}* was rejected.
आपका प्रोफाइल *${profileId}* reject कर दिया गया है।

💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

You can create a new profile after deleting this one.
इसे delete करने के बाद आप नया profile बना सकते हैं।`
        );
        await sendText(from, `✅ Rejected ${profileId}`);
      }
      return;
    }

    // ===================== SEARCH RESULTS: profile selection / commands =====================
    if (st.step === "SEARCH_RESULTS") {
      if (effectiveCmd === "NEXT" || effectiveCmd === "PREV") {
        // continue below
      } else if (effectiveCmd === "DETAILS" || effectiveCmd === "INTEREST") {
        // continue below
      } else if (isValidProfileId(rawInput)) {
        const selectedId = normalizeProfileId(rawInput);
        const results = temp.search?.results || [];
        const page = temp.search?.page || 0;
        const start = page * RESULTS_PAGE_SIZE;
        const end = start + RESULTS_PAGE_SIZE;
        const visible = results.slice(start, end).map((r) => normalizeProfileId(r.profile_id));
        if (!visible.includes(selectedId)) {
          await sendText(from, "Please select a Profile ID from the current list.\nकृपया current list में से ही Profile ID चुनें।");
          return;
        }
        temp.search.selected_profile_id = selectedId;
        await setState(from, "SEARCH_RESULTS", temp);
        await sendSelectedProfileActions(from, selectedId);
        return;
      } else {
        await sendText(
          from,
          "❌ Invalid response.\n\nPlease select a Profile ID, use NEXT / PREV, or tap Search Again.\nकृपया Profile ID चुनें, NEXT / PREV करें या Search Again चुनें।"
        );
        return;
      }
    }

    // ===================== MYPROFILES command =====================
    if (effectiveCmd === "MYPROFILES") {
      const profiles = await findProfilesByPhone(from);
      if (!profiles.length) {
        await sendText(from, `${WELCOME_MSG}`);
        await sendJoinStopButtons(from);
        return;
      }

      const lines = profiles.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`);
      await sendText(
        from,
        `💍 *${BRAND_NAME}*

Your Profiles
आपके प्रोफाइल

${lines.join("\n")}

👉 Select a profile or choose an action below
👉 नीचे दिए गए options में से चुनें`
      );
      await sendButtons(from, "Choose action\nAction चुनें", [
        { id: "MYP_DELETE", title: "DELETE" },
        { id: "JOIN", title: "JOIN" },
        { id: "MYP_DETAILS", title: "DETAILS" },
      ]);
      return;
    }

    // ===================== DELETE =====================
    if (effectiveCmd === "DELETE") {
      const profileId = normalizeProfileId(effectiveArgs[0]);
      if (!profileId) {
        await sendText(from, "Use: DELETE MH-XXXX");
        return;
      }

      if (!isValidProfileId(profileId)) {
        await sendText(from, "❌ Invalid Profile ID format.\nUse: DELETE MH-XXXX");
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
      await sendText(
        from,
        `✅ Profile deleted successfully.
प्रोफाइल सफलतापूर्वक delete हो गया।

Deleted: *${profileId}*`
      );
      await sendJoinStopButtons(from, "What would you like to do next?\nअब आगे क्या करना है?");
      return;
    }

    // ===================== MATCHES / SEARCH =====================
    if (effectiveCmd === "MATCHES" || effectiveCmd === "SEARCH") {
      await restartSearchFlow(from);
      return;
    }

    // ===================== NEXT / PREV =====================
    if (effectiveCmd === "NEXT" || effectiveCmd === "PREV") {
      if (!temp.search || !Array.isArray(temp.search.results)) {
        await sendText(from, "Type *SEARCH* to start searching.");
        return;
      }

      const total = temp.search.results.length;
      if (!total) {
        await sendText(from, "No search results. Type *SEARCH* again.");
        return;
      }

      const maxPage = Math.floor((total - 1) / RESULTS_PAGE_SIZE);
      let page = temp.search.page || 0;
      page = effectiveCmd === "NEXT" ? Math.min(maxPage, page + 1) : Math.max(0, page - 1);
      temp.search.page = page;
      temp.search.selected_profile_id = "";

      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    // ===================== DETAILS =====================
    if (effectiveCmd === "DETAILS") {
      const profileId = normalizeProfileId(effectiveArgs[0]);
      if (!profileId) {
        await sendText(from, "Use: DETAILS MH-XXXX");
        return;
      }

      if (!isValidProfileId(profileId)) {
        await sendText(from, "❌ Invalid Profile ID format.\nUse: DETAILS MH-XXXX");
        return;
      }

      const profiles = await findProfilesByPhone(from);
      const active = getLatestApprovedProfile(profiles);
      if (!active) {
        await sendText(from, PENDING_MSG);
        return;
      }

      const used = await countThisMonth({ from_profile_id: active.profile_id, type: "DETAILS" });
      if (used >= MAX_DETAILS_PER_MONTH) {
        await sendText(from, `⚠️ Monthly limit reached.\nMaximum ${MAX_DETAILS_PER_MONTH} details per month.`);
        return;
      }

      const target = await findProfileById(profileId);
      if (!target || cleanUpper(target.status) !== "APPROVED") {
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
`💍 *${BRAND_NAME}*

📄 Profile Details / प्रोफाइल जानकारी

ID: *${target.profile_id}*
Gender: ${target.gender}
Marital Status: ${target.marital_status || "NA"}
Age: ${age !== null ? age : "NA"}

Native: ${target.native_place}, ${target.district}
Work: ${target.work_city}, ${target.work_district}

Religion: ${target.religion}
Caste: ${target.caste}
Height: ${target.height}

Education: ${target.education}
Job Type: ${target.job}
Job Title: ${target.job_title}
Income: ${target.income_annual}

👇 Take action / आगे क्या करना है:`;

      if (target.photo_url) {
        await sendImageByLink(from, target.photo_url, cap);
      } else {
        await sendText(from, cap + "\n\n(No photo available)");
      }

      await sendButtons(from, "Choose action\nAction चुनें", [
        { id: `SEL_INTEREST_${target.profile_id}`, title: "INTEREST" },
        { id: "SEARCH_AGAIN", title: "Search Again" },
      ]);
      return;
    }

    // ===================== INTEREST =====================
    if (effectiveCmd === "INTEREST") {
      const profileId = normalizeProfileId(effectiveArgs[0]);
      if (!profileId) {
        await sendText(from, "Use: INTEREST MH-XXXX");
        return;
      }

      if (!isValidProfileId(profileId)) {
        await sendText(from, "❌ Invalid Profile ID format.\nUse: INTEREST MH-XXXX");
        return;
      }

      const profiles = await findProfilesByPhone(from);
      const active = getLatestApprovedProfile(profiles);
      if (!active) {
        await sendText(from, PENDING_MSG);
        return;
      }

      if (active.profile_id === profileId) {
        await sendText(from, "❌ You cannot send INTEREST to your own profile.");
        return;
      }

      const used = await countThisMonth({ from_profile_id: active.profile_id, type: "INTEREST" });
      if (used >= MAX_INTEREST_PER_MONTH) {
        await sendText(from, `⚠️ Monthly limit reached.\nMaximum ${MAX_INTEREST_PER_MONTH} interests per month.`);
        return;
      }

      const target = await findProfileById(profileId);
      if (!target || cleanUpper(target.status) !== "APPROVED") {
        await sendText(from, "Profile not found / not approved.");
        return;
      }

      const existing = await findInterestRequest({
        from_profile_id: active.profile_id,
        to_profile_id: target.profile_id,
      });

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
        `💌 *${BRAND_NAME}*

Someone showed interest in you.
किसी ने आपके प्रोफाइल में interest दिखाया है।

Interested Profile ID: *${active.profile_id}*

Reply:
ACCEPT ${active.profile_id}
REJECT ${active.profile_id}`
      );

      await sendText(from, `✅ Interest sent successfully.
Interest सफलतापूर्वक भेज दिया गया।`);
      return;
    }

    // ===================== ACCEPT / REJECT =====================
    if (effectiveCmd === "ACCEPT" || effectiveCmd === "REJECT") {
      const interestedProfileId = normalizeProfileId(effectiveArgs[0]);
      if (!interestedProfileId) {
        await sendText(from, "Use: ACCEPT MH-XXXX OR REJECT MH-XXXX");
        return;
      }

      if (!isValidProfileId(interestedProfileId)) {
        await sendText(from, "❌ Invalid Profile ID format.");
        return;
      }

      const receiverProfiles = await findProfilesByPhone(from);
      const receiverActive = getLatestApprovedProfile(receiverProfiles);
      if (!receiverActive) {
        await sendText(from, PENDING_MSG);
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

      const newStatus = effectiveCmd === "ACCEPT" ? "ACCEPTED" : "REJECTED";
      await updateRequestStatus(foundReq.rowIndex, newStatus);

      const senderProfile = await findProfileById(interestedProfileId);
      if (!senderProfile) {
        await sendText(from, "Interest processed, but sender profile not found.");
        return;
      }

      if (effectiveCmd === "REJECT") {
        await sendText(from, `❌ Rejected interest from ${interestedProfileId}.`);
        await sendText(senderProfile.phone, `❌ Your interest was rejected by ${receiverActive.profile_id}.`);
        return;
      }

      await sendText(from, `✅ Accepted interest from ${interestedProfileId}.
We are sharing contact details now.`);
      await sendText(from, `📞 Contact shared:\nProfile: ${interestedProfileId}\nPhone: ${senderProfile.phone}`);
      await sendText(
        senderProfile.phone,
        `✅ Your interest was accepted!

📞 Contact shared:
Profile: ${receiverActive.profile_id}
Phone: ${receiverActive.phone}`
      );
      return;
    }

    // ===================== SEARCH FLOW =====================
    if (st.step === "SEARCH_CITY_SCOPE") {
      if (interactiveId === "SEARCH_NATIVE_SAME" || rawInput === "1") {
        temp.search.cityScope = "SAME_CITY";
      } else if (interactiveId === "SEARCH_NATIVE_ANY" || rawInput === "2") {
        temp.search.cityScope = "ANY";
      } else {
        await sendText(from, makeInvalidReplyMsg("Please choose native preference."));
        await sendButtons(from, "Native place preference\nNative place के लिए preference चुनें", [
          { id: "SEARCH_NATIVE_SAME", title: "Same Native" },
          { id: "SEARCH_NATIVE_ANY", title: "Any Native" },
        ]);
        return;
      }

      await setState(from, "SEARCH_WORK_CITY_SCOPE", temp);
      await sendButtons(from, "Work city preference\nWork city के लिए preference चुनें", [
        { id: "SEARCH_WORK_SAME", title: "Same Work" },
        { id: "SEARCH_WORK_ANY", title: "Any City" },
      ]);
      return;
    }

    if (st.step === "SEARCH_WORK_CITY_SCOPE") {
      if (interactiveId === "SEARCH_WORK_SAME" || rawInput === "1") {
        temp.search.workCityScope = "SAME_CITY";
      } else if (interactiveId === "SEARCH_WORK_ANY" || rawInput === "2") {
        temp.search.workCityScope = "ANY";
      } else {
        await sendText(from, makeInvalidReplyMsg("Please choose work city preference."));
        await sendButtons(from, "Work city preference\nWork city के लिए preference चुनें", [
          { id: "SEARCH_WORK_SAME", title: "Same Work" },
          { id: "SEARCH_WORK_ANY", title: "Any City" },
        ]);
        return;
      }

      await setState(from, "SEARCH_AGE_RANGE", temp);
      await sendText(from, getPromptByStep("SEARCH_AGE_RANGE"));
      await sendButtons(from, "Choose option\nOption चुनें", [
        { id: "SKIP_AGE_RANGE", title: "SKIP" },
      ]);
      return;
    }

    if (st.step === "SEARCH_AGE_RANGE") {
      if (!rawInput) return;

      if (isSkip(rawInput)) {
        temp.search.ageMin = 21;
        temp.search.ageMax = 40;
      } else {
        const m = rawInput.match(/^(\d{2})-(\d{2})$/);
        if (!m) {
          await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_AGE_RANGE")));
          await sendButtons(from, "Choose option\nOption चुनें", [
            { id: "SKIP_AGE_RANGE", title: "SKIP" },
          ]);
          return;
        }
        const a1 = parseInt(m[1], 10);
        const a2 = parseInt(m[2], 10);
        if (!a1 || !a2 || a1 < MIN_AGE || a2 < MIN_AGE || a1 > a2) {
          await sendText(from, `❌ Invalid age range.\nMinimum age must be ${MIN_AGE}+.`);
          return;
        }
        temp.search.ageMin = a1;
        temp.search.ageMax = a2;
      }

      await setState(from, "SEARCH_CASTE_SCOPE", temp);
      await sendButtons(from, "Caste preference\nजात preference चुनें", [
        { id: "SEARCH_CASTE_SAME", title: "Same Caste" },
        { id: "SEARCH_CASTE_ANY", title: "Any Caste" },
      ]);
      return;
    }

    if (st.step === "SEARCH_CASTE_SCOPE") {
      if (interactiveId === "SEARCH_CASTE_SAME" || rawInput === "1") {
        temp.search.casteScope = "SAME_CASTE";
      } else if (interactiveId === "SEARCH_CASTE_ANY" || rawInput === "2") {
        temp.search.casteScope = "ANY";
      } else {
        await sendText(from, makeInvalidReplyMsg("Please choose caste preference."));
        await sendButtons(from, "Caste preference\nजात preference चुनें", [
          { id: "SEARCH_CASTE_SAME", title: "Same Caste" },
          { id: "SEARCH_CASTE_ANY", title: "Any Caste" },
        ]);
        return;
      }

      await setState(from, "SEARCH_EDU_MIN", temp);
      await sendButtons(from, "Minimum education\nMinimum education चुनें", [
        { id: "EDU_ANY", title: "Any" },
        { id: "EDU_GRAD", title: "Graduate" },
        { id: "EDU_POST", title: "Postgrad" },
      ]);
      return;
    }

    if (st.step === "SEARCH_EDU_MIN") {
      if (interactiveId === "EDU_ANY" || rawInput === "1") {
        temp.search.eduMinRank = null;
      } else if (interactiveId === "EDU_GRAD" || rawInput === "2") {
        temp.search.eduMinRank = 2;
      } else if (interactiveId === "EDU_POST" || rawInput === "3") {
        temp.search.eduMinRank = 3;
      } else {
        await sendText(from, makeInvalidReplyMsg("Please choose education preference."));
        await sendButtons(from, "Minimum education\nMinimum education चुनें", [
          { id: "EDU_ANY", title: "Any" },
          { id: "EDU_GRAD", title: "Graduate" },
          { id: "EDU_POST", title: "Postgrad" },
        ]);
        return;
      }

      await setState(from, "SEARCH_INCOME_MIN", temp);
      await sendList(
        from,
        "Minimum income preference\nMinimum income चुनें",
        "Select",
        [
          { id: "MININC_1", title: "Up to 50,000" },
          { id: "MININC_2", title: "50K - 1L" },
          { id: "MININC_3", title: "1L - 3L" },
          { id: "MININC_4", title: "Above 3L" },
          { id: "MININC_SKIP", title: "No Preference" },
        ],
        "Income Range"
      );
      return;
    }

    if (st.step === "SEARCH_INCOME_MIN") {
      if (!rawInput) return;

      if (interactiveId === "MININC_SKIP" || isSkip(rawInput)) {
        temp.search.incomeMinRank = null;
      } else if (interactiveId === "MININC_1") {
        temp.search.incomeMinRank = 1;
      } else if (interactiveId === "MININC_2") {
        temp.search.incomeMinRank = 2;
      } else if (interactiveId === "MININC_3") {
        temp.search.incomeMinRank = 3;
      } else if (interactiveId === "MININC_4") {
        temp.search.incomeMinRank = 4;
      } else {
        await sendText(from, "Please select an income range.");
        return;
      }

      const allRows = await getAllProfilesRows();
      const allProfiles = [];
      for (let i = 1; i < allRows.length; i++) {
        allProfiles.push(profileRowToObj(allRows[i], i + 1));
      }

      const results = applyFiltersToApprovedProfiles(allProfiles, {
        excludeProfileId: temp.search.from_profile_id,
        targetGender: temp.search.target_gender,
        cityScope: temp.search.cityScope,
        userCity: temp.search.user_city,
        workCityScope: temp.search.workCityScope,
        userWorkCity: temp.search.user_work_city,
        ageMin: temp.search.ageMin,
        ageMax: temp.search.ageMax,
        casteScope: temp.search.casteScope,
        userCaste: temp.search.user_caste,
        eduMinRank: temp.search.eduMinRank,
        incomeMinRank: temp.search.incomeMinRank,
      });

      temp.search.results = results;
      temp.search.page = 0;
      temp.search.selected_profile_id = "";

      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    // ===================== ONBOARDING DECISION =====================
    if (st.step === "ONBOARDING_DECISION") {
      if (interactiveId === "PROCEED" || effectiveCmd === "PROCEED") {
        await setState(from, "ASK_NAME", {});
        await sendText(from, getPromptByStep("ASK_NAME"));
        return;
      }

      if (interactiveId === "STOP" || effectiveCmd === "STOP") {
        await setState(from, "", {});
        await sendText(from, THANK_YOU_MARKETING_MSG);
        return;
      }

      await sendText(from, makeInvalidReplyMsg("Please choose Proceed or Stop."));
      await sendProceedStopButtons(from);
      return;
    }

    // ===================== REGISTRATION START =====================
    if (rawInput && (effectiveCmd === "JOIN" || effectiveCmd === "NEWPROFILE")) {
      const existing = await findProfilesByPhone(from);

      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        const lines = existing.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`).join("\n");
        await sendText(
          from,
          `⚠️ You already have ${existing.length} profiles (max ${MAX_PROFILES_PER_PHONE}).

${lines}

Delete one first:
जिस profile को delete करना है उसे नीचे tap करें`
        );

        const deleteButtons = existing.slice(0, 2).map((p) => ({
          id: `DEL_PROFILE_${p.profile_id}`,
          title: p.profile_id,
        }));

        await sendButtons(from, "Tap a profile\nकिस profile को delete करना है?", deleteButtons);
        return;
      }

      await sendText(from, WELCOME_MSG);
      await sendText(from, COMMANDS_MSG);
      await setState(from, "ONBOARDING_DECISION", {});
      await sendProceedStopButtons(from);
      return;
    }

    // ===================== NO ACTIVE STEP =====================
    if (!st.step) {
      if (rawInput) {
        await sendText(from, WELCOME_MSG);
        await sendText(from, COMMANDS_MSG);
        await setState(from, "ONBOARDING_DECISION", {});
        await sendProceedStopButtons(from);
      }
      return;
    }

    // ===================== REGISTRATION FLOW =====================
    if (st.step === "ASK_NAME") {
      if (!rawInput) return;
      temp.name = rawInput;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, getPromptByStep("ASK_SURNAME"));
      return;
    }

    if (st.step === "ASK_SURNAME") {
      if (!rawInput) return;
      temp.surname = rawInput;
      await setState(from, "ASK_GENDER", temp);
      await sendButtons(from, "Select Gender\nलिंग चुनें", [
        { id: "GENDER_MALE", title: "Male" },
        { id: "GENDER_FEMALE", title: "Female" },
      ]);
      return;
    }

    if (st.step === "ASK_GENDER") {
      let g = "";
      if (interactiveId === "GENDER_MALE") g = "male";
      else if (interactiveId === "GENDER_FEMALE") g = "female";
      else g = normalizeGender(rawInput);

      if (!g) {
        await sendText(from, makeInvalidReplyMsg("Please select gender."));
        await sendButtons(from, "Select Gender\nलिंग चुनें", [
          { id: "GENDER_MALE", title: "Male" },
          { id: "GENDER_FEMALE", title: "Female" },
        ]);
        return;
      }

      temp.gender = g;
      await setState(from, "ASK_MARITAL_STATUS", temp);
      await sendList(
        from,
        "Your Marital Status / आपकी वैवाहिक स्थिति",
        "Select",
        [
          { id: "MARITAL_UNMARRIED", title: "Unmarried", description: "अविवाहित" },
          { id: "MARITAL_DIVORCE", title: "Divorce", description: "घटस्फोटीत" },
          { id: "MARITAL_WIDOW", title: "Widower/Widow", description: "विधुर/विधवा" },
        ],
        "Marital Status"
      );
      return;
    }

    if (st.step === "ASK_MARITAL_STATUS") {
      let ms = "";
      if (interactiveId === "MARITAL_UNMARRIED") ms = "Unmarried";
      else if (interactiveId === "MARITAL_DIVORCE") ms = "Divorce";
      else if (interactiveId === "MARITAL_WIDOW") ms = "Widower/Widow";
      else ms = maritalStatusFromInput(rawInput);

      if (!ms) {
        await sendText(from, "Please select marital status.");
        return;
      }

      temp.marital_status = ms;
      await setState(from, "ASK_DOB", temp);
      await sendText(from, getPromptByStep("ASK_DOB"));
      return;
    }

    if (st.step === "ASK_DOB") {
      if (!rawInput) return;

      const age = calcAgeFromDobDDMMYYYY(rawInput);
      if (age === null) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ASK_DOB")));
        return;
      }

      if (age < MIN_AGE) {
        await setState(from, "", {});
        await sendText(from, `❌ Registration not allowed. Minimum age is ${MIN_AGE}.`);
        return;
      }

      temp.date_of_birth = rawInput;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, getPromptByStep("ASK_HEIGHT"));
      return;
    }

    if (st.step === "ASK_HEIGHT") {
      if (!rawInput) return;
      temp.height = rawInput;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, getPromptByStep("ASK_RELIGION"));
      return;
    }

    if (st.step === "ASK_RELIGION") {
      if (!rawInput) return;
      temp.religion = rawInput;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, getPromptByStep("ASK_CASTE"));
      return;
    }

    if (st.step === "ASK_CASTE") {
      if (!rawInput) return;
      temp.caste = rawInput;
      await setState(from, "ASK_NATIVE_PLACE", temp);
      await sendText(from, getPromptByStep("ASK_NATIVE_PLACE"));
      return;
    }

    if (st.step === "ASK_NATIVE_PLACE") {
      if (!rawInput) return;
      temp.native_place = rawInput;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, getPromptByStep("ASK_DISTRICT"));
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      if (!rawInput) return;
      temp.district = rawInput;
      await setState(from, "ASK_WORK_CITY", temp);
      await sendText(from, getPromptByStep("ASK_WORK_CITY"));
      return;
    }

    if (st.step === "ASK_WORK_CITY") {
      if (!rawInput) return;

      if (isSame(rawInput)) temp.work_city = temp.native_place || "";
      else temp.work_city = rawInput;

      await setState(from, "ASK_WORK_DISTRICT", temp);
      await sendText(from, getPromptByStep("ASK_WORK_DISTRICT"));
      return;
    }

    if (st.step === "ASK_WORK_DISTRICT") {
      if (!rawInput) return;

      if (isSkip(rawInput)) temp.work_district = "";
      else if (isSame(rawInput)) temp.work_district = temp.district || "";
      else temp.work_district = rawInput;

      await setState(from, "ASK_EDU", temp);
      await sendText(from, getPromptByStep("ASK_EDU"));
      return;
    }

    if (st.step === "ASK_EDU") {
      if (!rawInput) return;
      temp.education = rawInput;
      await setState(from, "ASK_JOB", temp);
      await sendButtons(from, "Select Job Type\nनौकरी / काम का प्रकार चुनें", [
        { id: "JOB_GOVT", title: "Government" },
        { id: "JOB_PRIVATE", title: "Private" },
        { id: "JOB_BUSINESS", title: "Business" },
      ]);
      return;
    }

    if (st.step === "ASK_JOB") {
      let job = "";
      if (interactiveId === "JOB_GOVT") job = "Government";
      else if (interactiveId === "JOB_PRIVATE") job = "Private";
      else if (interactiveId === "JOB_BUSINESS") job = "Business";
      else {
        const x = cleanLower(rawInput);
        if (x.includes("gov")) job = "Government";
        else if (x.includes("private")) job = "Private";
        else if (x.includes("business")) job = "Business";
      }

      if (!job) {
        await sendText(from, "Please select job type.");
        await sendButtons(from, "Select Job Type\nनौकरी / काम का प्रकार चुनें", [
          { id: "JOB_GOVT", title: "Government" },
          { id: "JOB_PRIVATE", title: "Private" },
          { id: "JOB_BUSINESS", title: "Business" },
        ]);
        return;
      }

      temp.job = job;
      await setState(from, "ASK_JOB_TITLE", temp);
      await sendText(from, getPromptByStep("ASK_JOB_TITLE"));
      return;
    }

    if (st.step === "ASK_JOB_TITLE") {
      if (!rawInput) return;
      temp.job_title = rawInput;
      await setState(from, "ASK_INCOME", temp);
      await sendList(
        from,
        "Select Monthly Income\nमासिक आय चुनें",
        "Select",
        [
          { id: "INC_1", title: "Up to 50,000" },
          { id: "INC_2", title: "50,000 to 1,00,000" },
          { id: "INC_3", title: "1,00,000 to 3,00,000" },
          { id: "INC_4", title: "Above 3,00,000" },
        ],
        "Income Range"
      );
      return;
    }

    if (st.step === "ASK_INCOME") {
      let income = "";
      if (interactiveId === "INC_1") income = "Up to 50,000";
      else if (interactiveId === "INC_2") income = "50,000 to 1,00,000";
      else if (interactiveId === "INC_3") income = "1,00,000 to 3,00,000";
      else if (interactiveId === "INC_4") income = "Above 3,00,000";
      else income = rawInput;

      if (!income) {
        await sendText(from, "Please select income range.");
        return;
      }

      temp.income_annual = income;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, getPromptByStep("ASK_PHOTO"));
      return;
    }

    // ===================== PHOTO STEP =====================
    if (st.step === "ASK_PHOTO") {
      if (msgType !== "image") {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ASK_PHOTO")));
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
        const { bytes } = await downloadMetaMediaBytes(metaUrl);
        const filename = `MH_${from}_${Date.now()}.jpg`;
        permanentLink = await uploadPhotoToCloudinary(bytes, filename);
      } catch (e) {
        console.error("Photo upload error:", e?.response?.data || e.message);
      }

      if (!permanentLink) {
        await sendText(from, "Photo upload failed. Please send photo again later.");
        return;
      }

      temp.photo_url = permanentLink;

      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);

      await setState(from, "", {});
      await sendText(
        from,
        `✅ Registration completed!
पंजीकरण पूरा हुआ!

Your Profile ID: *${profileId}*
आपका प्रोफाइल ID: *${profileId}*

💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

Status: *Approval pending*
स्टेटस: *Approval pending hai*

You will receive a message after your profile is approved
प्रोफाइल approve होने के बाद आपको message मिलेगा

👇 Click the button below to view your profiles
👇 अपने profiles देखने के लिए नीचे दिए गए button पर click करें`
      );
      await sendButtons(from, "View your profiles\nअपने profiles देखें", [
        { id: "MYPROFILES_BTN", title: "MYPROFILES" },
      ]);
      return;
    }
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
  }
});

// ===================== Start Server =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
