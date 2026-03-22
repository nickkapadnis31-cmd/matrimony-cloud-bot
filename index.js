// index.js — Vivaho WhatsApp Matrimony Bot (Meta Cloud API + Google Sheets + Cloudinary)
//
// Brand: Vivaho
// Tagline: “नवीन नाती – विश्वासाने जोडलेली.”
//
// Features:
// - Max 2 profiles per phone (JOIN/NewProfile blocked if 2)
// - MYPROFILES, DELETE MH-XXXX
// - Admin approve/reject (restricted by ADMIN_PHONE)
// - Only APPROVED can browse matches; results only APPROVED
// - 18+ enforced on registration and results
// - Photo stored permanently in Cloudinary; stored in profiles.photo_url (public URL)
// - MATCHES: opposite gender + asks filters; shows 5 results + NEXT/PREV
// - DETAILS MH-XXXX: max 5/month; sends WhatsApp image + details (without name)
// - INTEREST MH-XXXX: max 5/month; notifies target; ACCEPT/REJECT to share contact
// - requests sheet columns: A req_id, B from_profile_id, C to_profile_id, D status, E created_at, F type, G viewer_phone
//
// PROFILES SHEET (A–T) columns:
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
// Q income_annual
// R photo_url
// S status
// T created_at

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
  return isoString.slice(0, 7); // YYYY-MM
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

function isYes1(v) {
  return String(v || "").trim() === "1";
}

function isNo2(v) {
  return String(v || "").trim() === "2";
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
  console.warn("⚠️ Missing required env vars. Check VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID, GOOGLE_SHEET_ID.");
}
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.warn("⚠️ Missing GOOGLE_SERVICE_ACCOUNT_JSON env var.");
}
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.warn("⚠️ Missing Cloudinary env vars. Check CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.");
}

function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

// ===================== Branding =====================
const BRAND_NAME = "Vivaho";
const BRAND_SUBTITLE = "Matrimony Service";
const BRAND_TAGLINE = "नवीन नाती – विश्वासाने जोडलेली.";

const MAX_PROFILES_PER_PHONE = 2;
const MIN_AGE = 18;
const MAX_DETAILS_PER_MONTH = 5;
const MAX_INTEREST_PER_MONTH = 5;
const RESULTS_PAGE_SIZE = 5;

const PROFILE_TAB = "profiles";
const STATE_TAB = "state";
const REQUESTS_TAB = "requests";

// ===================== Messages =====================
const WELCOME_MSG =
`💍 *${BRAND_NAME}*
${BRAND_SUBTITLE}
${BRAND_TAGLINE}

विश्वासाने जुळवा योग्य स्थळ ❤️
Find the right match with trust.`;

const COMMANDS_MSG =
`📘 *${BRAND_NAME} वापरण्याची पद्धत / How it works*

*JOIN* → नवीन प्रोफाइल तयार करा
*MATCHES* → योग्य स्थळ शोधा
*DETAILS MH-XXXX* → प्रोफाइलची माहिती पहा
*INTEREST MH-XXXX* → आवड दर्शवा
*MYPROFILES* → तुमची प्रोफाइल्स पहा
*DELETE MH-XXXX* → प्रोफाइल डिलीट करा
*STOP* → चालू प्रक्रिया थांबवा

⏳ प्रोफाइल *Approved* झाल्यानंतरच तुम्ही MATCHES / DETAILS / INTEREST वापरू शकता.

पुढे जाण्यासाठी *1* पाठवा
थांबवण्यासाठी *2* पाठवा`;

const THANK_YOU_MARKETING_MSG =
`🙏 Thank you for connecting with *${BRAND_NAME}*.

तुमच्या मनासारखा जोडीदार शोधण्यासाठी आम्हाला पुन्हा मेसेज करा ❤️

📩 प्रोफाइल सुरू करण्यासाठी कधीही *JOIN* पाठवा.

*${BRAND_NAME}*  
${BRAND_TAGLINE}`;

const PENDING_MSG =
`💍 *${BRAND_NAME}*

तुमचे प्रोफाइल अजून *Approved* झालेले नाही.
Your profile is not approved yet.

⏳ कृपया Admin approval साठी थोडा वेळ प्रतीक्षा करा.
Please wait for admin approval.

Approved झाल्यानंतर स्थळ शोधण्यासाठी *MATCHES* लिहा.`;

const DETAILS_INTEREST_LOCK_MSG =
`💍 *${BRAND_NAME}*

⏳ Your profile is not approved yet.
Please wait for admin approval.

Only APPROVED users can use DETAILS and INTEREST.

${BRAND_TAGLINE}`;

function getPromptByStep(step, temp = {}) {
  switch (step) {
    case "ONBOARDING_DECISION":
      return COMMANDS_MSG;
    case "ASK_NAME":
      return `${WELCOME_MSG}\n\nReply with your *Name*:\nतुमचे नाव पाठवा`;
    case "ASK_SURNAME":
      return "Good. Now reply with your *Surname*:\nआडनाव पाठवा";
    case "ASK_GENDER":
      return "Gender? Reply *Male* or *Female*:\nलिंग: Male / Female";
    case "ASK_DOB":
      return "Date of Birth? Format: *DD-MM-YYYY* (example 05-11-1998)\nजन्मतारीख: DD-MM-YYYY";
    case "ASK_HEIGHT":
      return "Height? (Example: 5'6 or 168 cm):\nउंची?";
    case "ASK_RELIGION":
      return "Religion? (Example: Hindu / Muslim / Jain / Buddhist):\nधर्म?";
    case "ASK_CASTE":
      return "Caste? (Example: Maratha / Brahmin / Kunbi / etc.):\nजात?";
    case "ASK_NATIVE_PLACE":
      return "तुमचे मूळ गाव कोणते आहे?\nWhat is your native place?\n\nउदा / Example: Satara / Kolhapur / Nandurbar";
    case "ASK_DISTRICT":
      return "District? Example: Pune / Nashik / Mumbai Suburban:\nजिल्हा?";
    case "ASK_WORK_CITY":
      return "सध्या तुम्ही कोणत्या शहरात काम करता?\nWhich city do you currently work in?\n\nउदा / Example: Pune / Mumbai / Nashik\n\nNative आणि Work city एकच असेल तर SAME लिहा.\nIf same as native place, type SAME.";
    case "ASK_WORK_DISTRICT":
      return "कामाचा जिल्हा कोणता आहे?\nWhich district is your work location in?\n\nउदा / Example: Pune / Mumbai Suburban / Nashik\n\nमाहित नसेल तर SKIP लिहा.\nIf unknown, type SKIP.";
    case "ASK_EDU":
      return "Education? (Example: B.Com / BE / MBA):\nशिक्षण?";
    case "ASK_JOB":
      return "तुमचा व्यवसाय/नोकरी प्रकार काय?\nJob type? (Example: Government / Private / Business)\n\nउदा / Example: Govt / Private / Business";
    case "ASK_JOB_TITLE":
      return "तुम्ही नेमके काय काम करता?\nWhat exactly is your job role?\n\nउदा / Example:\nSoftware Engineer\nPolice Constable\nTeacher\nBusiness – Garments";
    case "ASK_INCOME":
      return "Annual Income? (Example: 5 LPA / 10 LPA / 15 LPA):\nवार्षिक उत्पन्न?";
    case "ASK_PHOTO":
      return "Please send *one clear photo* (selfie or portrait). Photo is mandatory ✅\nफोटो पाठवा ✅";
    case "SEARCH_CITY_SCOPE":
      return `Search preferences:\n1) Same Native Place (${temp?.search?.user_city || "your native place"})\n2) Any Native Place in Maharashtra\n\nReply 1 or 2`;
    case "SEARCH_WORK_CITY_SCOPE":
      return "Work location preference?\n1) Same work city\n2) Any work city\nReply 1 or 2";
    case "SEARCH_AGE_RANGE":
      return "Preferred age range? Example: 23-30\nType SKIP for default (21-40).";
    case "SEARCH_CASTE_SCOPE":
      return `Caste preference?\n1) Same caste (${temp?.search?.user_caste || "your caste"})\n2) Any caste\nReply 1 or 2`;
    case "SEARCH_EDU_MIN":
      return "Minimum education?\n1) Any\n2) Graduate\n3) Postgraduate\nReply 1/2/3";
    case "SEARCH_INCOME_MIN":
      return "Minimum income (LPA)? Example: 5\nType SKIP for any.";
    default:
      return "";
  }
}

function makeInvalidReplyMsg(originalPrompt) {
  return `❌ Invalid response.\n\nकृपया *STOP* टाइप करा if you want to cancel.\nPlease reply only with the expected answer.\n\n${originalPrompt}`;
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
  if (!phone) {
    console.log("sendText skipped: empty phone");
    return;
  }

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

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "image",
        image: {
          link: imageLink,
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
  } catch (err) {
    console.error("sendImageByLink failed:", JSON.stringify(err?.response?.data || err.message));
    throw err;
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
    range: `${PROFILE_TAB}!A:T`,
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
  };

  obj.city = obj.native_place; // backward compatibility
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
    profile_id,
    phone,
    temp.name || "",
    temp.surname || "",
    temp.gender || "",
    temp.date_of_birth || "",
    temp.religion || "",
    temp.height || "",
    temp.caste || "",
    temp.native_place || "",
    temp.district || "",
    temp.work_city || "",
    temp.work_district || "",
    temp.education || "",
    temp.job || "",
    temp.job_title || "",
    temp.income_annual || "",
    temp.photo_url || "",
    "PENDING",
    createdAt,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:T`,
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

Brand: ${BRAND_NAME}
Tagline: ${BRAND_TAGLINE}

Profile ID: ${profileId}
Phone: ${phone}
Name: ${(temp?.name || "")} ${(temp?.surname || "")}
Gender: ${temp?.gender || ""}
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

✅ Approve: approve ${profileId}
❌ Reject: reject ${profileId}`;

  await sendText(ADMIN_PHONE, msg);
}

// ===================== Matching Helpers =====================
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
    await sendText(to, `💍 *${BRAND_NAME}*\n\nNo matches found with your preferences.\nTry again with different filters.`);
    return;
  }

  const start = page * RESULTS_PAGE_SIZE;
  const end = start + RESULTS_PAGE_SIZE;
  const chunk = results.slice(start, end);

  let msg = `💍 *${BRAND_NAME}*\n\n🔎 Matches (${start + 1}-${Math.min(end, results.length)} of ${results.length})\n\n`;
  msg += chunk.map(buildProfileCardLine).join("\n");
  msg += `\n\nCommands:\n*NEXT* | *PREV*\n*DETAILS MH-XXXX*\n*INTEREST MH-XXXX*`;

  await sendText(to, msg);
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

    const st = await getState(from);
    const temp = safeJsonParse(st.temp_data || "{}", {});
    const { cmd, args } = parseCommand(text);

    // ===================== GLOBAL CANCEL =====================
    if (cmd === "STOP" || cmd === "CANCEL") {
      await setState(from, "", {});
      await sendText(from, `✅ Cancelled.\n\n${WELCOME_MSG}\n\nType *JOIN* to start again.`);
      return;
    }

    // ===================== ADMIN COMMANDS =====================
    if (text && (cmd === "APPROVE" || cmd === "REJECT")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can approve/reject profiles.");
        return;
      }

      const profileId = normalizeProfileId(args[0]);
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
        await sendText(
          prof.phone,
          `🎉 अभिनंदन! तुमचे प्रोफाइल *${profileId}* *Approved* झाले आहे.\n\n💍 *${BRAND_NAME}*\n${BRAND_TAGLINE}\n\nस्थळ शोधण्यासाठी *MATCHES* लिहा.\nType *MATCHES* to browse profiles.`
        );
        await sendText(from, `✅ Approved ${profileId}`);
      } else {
        await sendText(
          prof.phone,
          `❌ Your profile *${profileId}* was *REJECTED*.\n\n💍 *${BRAND_NAME}*\n${BRAND_TAGLINE}\n\nYou can create a new profile after deleting this one.`
        );
        await sendText(from, `✅ Rejected ${profileId}`);
      }
      return;
    }

    // ===================== RESULTS INVALID REPLY PROTECTION =====================
    if (st.step === "SEARCH_RESULTS") {
      const valid = cmd === "NEXT" || cmd === "PREV" || cmd === "DETAILS" || cmd === "INTEREST";
      if (!valid) {
        await sendText(
          from,
          "❌ Invalid response.\n\nPlease send one of these:\n*NEXT*\n*PREV*\n*DETAILS MH-XXXX*\n*INTEREST MH-XXXX*\n\nOr type *STOP* to start again."
        );
        return;
      }
    }

    // ===================== MYPROFILES =====================
    if (cmd === "MYPROFILES") {
      const profiles = await findProfilesByPhone(from);
      if (!profiles.length) {
        await sendText(from, `${WELCOME_MSG}\n\nType *JOIN* to create your profile.`);
        return;
      }

      const lines = profiles.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`);
      await sendText(
        from,
        `💍 *${BRAND_NAME}*\n\nYour profiles:\n${lines.join("\n")}\n\nDelete: *DELETE MH-XXXX*\nCreate new: *JOIN* (max ${MAX_PROFILES_PER_PHONE})`
      );
      return;
    }

    // ===================== DELETE =====================
    if (cmd === "DELETE") {
      const profileId = normalizeProfileId(args[0]);
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
      await sendText(from, `✅ Deleted ${profileId}.\n\n💍 *${BRAND_NAME}*\nType *JOIN* to create a new profile.`);
      return;
    }

    // ===================== MATCHES =====================
    if (cmd === "MATCHES" || cmd === "SEARCH") {
      const profiles = await findProfilesByPhone(from);

      if (!profiles.length) {
        await sendText(from, `${WELCOME_MSG}\n\nType *JOIN* to create your profile.`);
        return;
      }

      const active = getLatestApprovedProfile(profiles);
      if (!active) {
        await sendText(from, PENDING_MSG);
        return;
      }

      const targetGender = oppositeGender(active.gender);
      if (!targetGender) {
        await sendText(from, "Your gender is missing in profile. Please create a new profile.");
        return;
      }

      temp.search = {
        from_profile_id: active.profile_id,
        user_city: active.native_place || active.city || "",
        user_caste: active.caste || "",
        user_work_city: active.work_city || "",
        target_gender: targetGender,
        cityScope: null,
        workCityScope: null,
        ageMin: null,
        ageMax: null,
        casteScope: null,
        eduMinRank: null,
        incomeMin: null,
        results: [],
        page: 0,
      };

      await setState(from, "SEARCH_CITY_SCOPE", temp);
      await sendText(from, getPromptByStep("SEARCH_CITY_SCOPE", temp));
      return;
    }

    // ===================== NEXT / PREV =====================
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

    // ===================== DETAILS =====================
    if (cmd === "DETAILS") {
      const profileId = normalizeProfileId(args[0]);
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
        await sendText(from, `⚠️ Monthly limit reached.\nYou can view maximum ${MAX_DETAILS_PER_MONTH} profile details per month.`);
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

📄 Profile Details
ID: ${target.profile_id}
Gender: ${target.gender}
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

If interested: INTEREST ${target.profile_id}`;

      if (target.photo_url) {
        await sendImageByLink(from, target.photo_url, cap);
      } else {
        await sendText(from, cap + "\n\n(No photo available)");
      }
      return;
    }

    // ===================== INTEREST =====================
    if (cmd === "INTEREST") {
      const profileId = normalizeProfileId(args[0]);
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
        await sendText(from, `⚠️ Monthly limit reached.\nYou can send maximum ${MAX_INTEREST_PER_MONTH} interests per month.`);
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
        `💌 *${BRAND_NAME}*\n\nSomeone showed interest in you!\n\nInterested Profile ID: *${active.profile_id}*\n\nReply:\nACCEPT ${active.profile_id}\nREJECT ${active.profile_id}`
      );

      await sendText(from, `✅ Interest sent to ${target.profile_id}.\nYou will be notified if they accept.`);
      return;
    }

    // ===================== ACCEPT / REJECT INTEREST =====================
    if (cmd === "ACCEPT" || cmd === "REJECT") {
      const interestedProfileId = normalizeProfileId(args[0]);
      if (!interestedProfileId) {
        await sendText(from, "Use: ACCEPT MH-XXXX  OR  REJECT MH-XXXX");
        return;
      }

      if (!isValidProfileId(interestedProfileId)) {
        await sendText(from, "❌ Invalid Profile ID format.\nUse: ACCEPT MH-XXXX  OR  REJECT MH-XXXX");
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
      await sendText(from, `📞 Contact shared:\nProfile: ${interestedProfileId}\nPhone: ${senderProfile.phone}`);
      await sendText(
        senderProfile.phone,
        `✅ Your interest was accepted!\n\n📞 Contact shared:\nProfile: ${receiverActive.profile_id}\nPhone: ${receiverActive.phone}`
      );
      return;
    }

    // ===================== SEARCH FLOW =====================
    if (st.step === "SEARCH_CITY_SCOPE") {
      if (!text || (!isYes1(text) && !isNo2(text))) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_CITY_SCOPE", temp)));
        return;
      }

      temp.search.cityScope = isYes1(text) ? "SAME_CITY" : "ANY";
      await setState(from, "SEARCH_WORK_CITY_SCOPE", temp);
      await sendText(from, getPromptByStep("SEARCH_WORK_CITY_SCOPE", temp));
      return;
    }

    if (st.step === "SEARCH_WORK_CITY_SCOPE") {
      if (!text || (!isYes1(text) && !isNo2(text))) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_WORK_CITY_SCOPE", temp)));
        return;
      }

      temp.search.workCityScope = isYes1(text) ? "SAME_CITY" : "ANY";
      await setState(from, "SEARCH_AGE_RANGE", temp);
      await sendText(from, getPromptByStep("SEARCH_AGE_RANGE", temp));
      return;
    }

    if (st.step === "SEARCH_AGE_RANGE") {
      if (!text) return;

      if (isSkip(text)) {
        temp.search.ageMin = 21;
        temp.search.ageMax = 40;
      } else {
        const m = text.match(/^(\d{2})-(\d{2})$/);
        if (!m) {
          await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_AGE_RANGE", temp)));
          return;
        }
        const a1 = parseInt(m[1], 10);
        const a2 = parseInt(m[2], 10);
        if (!a1 || !a2 || a1 < MIN_AGE || a2 < MIN_AGE || a1 > a2) {
          await sendText(from, `❌ Invalid age range.\nMinimum age must be ${MIN_AGE}+.\nExample: *23-30*\nOr type *STOP* to start again.`);
          return;
        }
        temp.search.ageMin = a1;
        temp.search.ageMax = a2;
      }

      await setState(from, "SEARCH_CASTE_SCOPE", temp);
      await sendText(from, getPromptByStep("SEARCH_CASTE_SCOPE", temp));
      return;
    }

    if (st.step === "SEARCH_CASTE_SCOPE") {
      if (!text || (!isYes1(text) && !isNo2(text))) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_CASTE_SCOPE", temp)));
        return;
      }

      temp.search.casteScope = isYes1(text) ? "SAME_CASTE" : "ANY";
      await setState(from, "SEARCH_EDU_MIN", temp);
      await sendText(from, getPromptByStep("SEARCH_EDU_MIN", temp));
      return;
    }

    if (st.step === "SEARCH_EDU_MIN") {
      if (!["1", "2", "3"].includes(text)) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_EDU_MIN", temp)));
        return;
      }

      temp.search.eduMinRank = text === "1" ? null : text === "2" ? 2 : 3;
      await setState(from, "SEARCH_INCOME_MIN", temp);
      await sendText(from, getPromptByStep("SEARCH_INCOME_MIN", temp));
      return;
    }

    if (st.step === "SEARCH_INCOME_MIN") {
      if (!text) return;

      if (isSkip(text)) {
        temp.search.incomeMin = null;
      } else {
        const v = parseFloat(text);
        if (Number.isNaN(v) || v < 0) {
          await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_INCOME_MIN", temp)));
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
        incomeMin: temp.search.incomeMin,
      });

      temp.search.results = results;
      temp.search.page = 0;

      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
      return;
    }

    // ===================== ONBOARDING DECISION =====================
    if (st.step === "ONBOARDING_DECISION") {
      if (!text || (!isYes1(text) && !isNo2(text))) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ONBOARDING_DECISION", temp)));
        return;
      }

      if (isNo2(text)) {
        await setState(from, "", {});
        await sendText(from, THANK_YOU_MARKETING_MSG);
        return;
      }

      await setState(from, "ASK_NAME", {});
      await sendText(from, getPromptByStep("ASK_NAME"));
      return;
    }

    // ===================== REGISTRATION START =====================
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

      await sendText(from, WELCOME_MSG);
      await sendText(from, COMMANDS_MSG);
      await setState(from, "ONBOARDING_DECISION", {});
      return;
    }

    // ===================== NO ACTIVE STEP =====================
    if (!st.step) {
      if (text) {
        await sendText(from, WELCOME_MSG);
        await sendText(from, COMMANDS_MSG);
        await setState(from, "ONBOARDING_DECISION", {});
      }
      return;
    }

    // ===================== REGISTRATION FLOW =====================
    if (st.step === "ASK_NAME") {
      if (!text) return;
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, getPromptByStep("ASK_SURNAME", temp));
      return;
    }

    if (st.step === "ASK_SURNAME") {
      if (!text) return;
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendText(from, getPromptByStep("ASK_GENDER", temp));
      return;
    }

    if (st.step === "ASK_GENDER") {
      if (!text) return;

      const g = normalizeGender(text);
      if (!g) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ASK_GENDER", temp)));
        return;
      }

      temp.gender = g;
      await setState(from, "ASK_DOB", temp);
      await sendText(from, getPromptByStep("ASK_DOB", temp));
      return;
    }

    if (st.step === "ASK_DOB") {
      if (!text) return;

      const age = calcAgeFromDobDDMMYYYY(text);
      if (age === null) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ASK_DOB", temp)));
        return;
      }

      if (age < MIN_AGE) {
        await setState(from, "", {});
        await sendText(from, `❌ Registration not allowed. Minimum age is ${MIN_AGE} years.`);
        return;
      }

      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, getPromptByStep("ASK_HEIGHT", temp));
      return;
    }

    if (st.step === "ASK_HEIGHT") {
      if (!text) return;
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, getPromptByStep("ASK_RELIGION", temp));
      return;
    }

    if (st.step === "ASK_RELIGION") {
      if (!text) return;
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, getPromptByStep("ASK_CASTE", temp));
      return;
    }

    if (st.step === "ASK_CASTE") {
      if (!text) return;
      temp.caste = text;
      await setState(from, "ASK_NATIVE_PLACE", temp);
      await sendText(from, getPromptByStep("ASK_NATIVE_PLACE", temp));
      return;
    }

    if (st.step === "ASK_NATIVE_PLACE") {
      if (!text) return;
      temp.native_place = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, getPromptByStep("ASK_DISTRICT", temp));
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      if (!text) return;
      temp.district = text;
      await setState(from, "ASK_WORK_CITY", temp);
      await sendText(from, getPromptByStep("ASK_WORK_CITY", temp));
      return;
    }

    if (st.step === "ASK_WORK_CITY") {
      if (!text) return;

      if (isSame(text)) {
        temp.work_city = temp.native_place || "";
      } else {
        temp.work_city = text;
      }

      await setState(from, "ASK_WORK_DISTRICT", temp);
      await sendText(from, getPromptByStep("ASK_WORK_DISTRICT", temp));
      return;
    }

    if (st.step === "ASK_WORK_DISTRICT") {
      if (!text) return;

      if (isSkip(text)) {
        temp.work_district = "";
      } else if (isSame(text)) {
        temp.work_district = temp.district || "";
      } else {
        temp.work_district = text;
      }

      await setState(from, "ASK_EDU", temp);
      await sendText(from, getPromptByStep("ASK_EDU", temp));
      return;
    }

    if (st.step === "ASK_EDU") {
      if (!text) return;
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendText(from, getPromptByStep("ASK_JOB", temp));
      return;
    }

    if (st.step === "ASK_JOB") {
      if (!text) return;
      temp.job = text;
      await setState(from, "ASK_JOB_TITLE", temp);
      await sendText(from, getPromptByStep("ASK_JOB_TITLE", temp));
      return;
    }

    if (st.step === "ASK_JOB_TITLE") {
      if (!text) return;
      temp.job_title = text;
      await setState(from, "ASK_INCOME", temp);
      await sendText(from, getPromptByStep("ASK_INCOME", temp));
      return;
    }

    if (st.step === "ASK_INCOME") {
      if (!text) return;
      temp.income_annual = text;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, getPromptByStep("ASK_PHOTO", temp));
      return;
    }

    // ===================== PHOTO STEP =====================
    if (st.step === "ASK_PHOTO") {
      if (msgType !== "image") {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ASK_PHOTO", temp)));
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
        await sendText(from, "Photo upload failed. Please send photo again after some time.");
        return;
      }

      temp.photo_url = permanentLink;

      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);

      await setState(from, "", {});

      await sendText(
        from,
        `✅ Registration completed!\nYour Profile ID: *${profileId}*\n\n💍 *${BRAND_NAME}*\n${BRAND_TAGLINE}\n\nStatus: *PENDING approval*.\nYou will get message after approval.\n\nType *MYPROFILES* to view your profiles.`
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
