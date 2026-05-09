// index.js — Vivaho WhatsApp Matrimony Bot (Meta Cloud API + Google Sheets + Cloudinary)
//
// Brand: Vivaho
// Tagline: "नवीन नाती – विश्वासाने जोडलेली."
//
// Features:
// - Max 1 profile per phone
// - Anyone can search (no profile needed)
// - MYPROFILES, DELETE MH-XXXX
// - Admin approve/reject with payment plans
// - Only PAID users can send interest/view contact
// - 18+ enforced
// - Photo stored in Cloudinary
// - SEARCH with Bride/Groom selection + one profile at a time
// - SELECT button shows SEND INTEREST / VIEW CONTACT DETAILS
// - Search shows ALL profiles (PENDING + APPROVED)
// - Interactive Buttons + Lists for guided UX
//
// PROFILES SHEET (A–X) columns:
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
// S approved_1 (PENDING/APPROVED/REJECTED/EXPIRED)
// T approved_1_expiry (date)
// U approved_2 (PENDING/APPROVED/REJECTED/EXPIRED)
// V approved_2_expiry (date)
// W created_at
// X marital_status

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

function addMonths(date, months) {
  const newDate = new Date(date);
  newDate.setMonth(newDate.getMonth() + months);
  return newDate.toISOString();
}

function addYears(date, years) {
  const newDate = new Date(date);
  newDate.setFullYear(newDate.getFullYear() + years);
  return newDate.toISOString();
}

function isExpired(expiryDateStr) {
  if (!expiryDateStr) return true;
  const expiry = new Date(expiryDateStr);
  const now = new Date();
  return expiry < now;
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
  if (x.includes("widower") || x.includes("widow") || x.includes("विधुर") || x.includes("विधवा")) {
    return "Widower/Widow";
  }
  return "";
}

function trimTo(str, max) {
  return String(str || "").slice(0, max);
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

// UPI for payments
const UPI_ID = process.env.UPI_ID || "vivaho@okhdfcbank";
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

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

const MAX_PROFILES_PER_PHONE = 1;
const MIN_AGE = 18;

// ===================== Engaging Welcome Messages =====================
const WELCOME_MSG = `✨ *Namaste! Welcome to ${BRAND_NAME}* ✨

💍 *${BRAND_NAME}* - ${BRAND_SUBTITLE}
🌸 *${BRAND_TAGLINE}* 🌸

*आपका अपना विश्वसनीय मैट्रिमोनी सर्विस!*
*Your trusted matrimony service!*

🎯 *हमारा उद्देश्य / Our Mission:*
सही जीवनसाथी ढूंढना अब हुआ आसान!
Finding the right life partner is now easy!

❤️ *Why ${BRAND_NAME}?*
• 100% Verified Profiles
• Privacy Focused
• Easy to Use on WhatsApp
• Safe & Secure

👇 *Let's get started! आइए शुरू करते हैं!* 👇`;

const ENGAGING_JOIN_MSG = `💫 *Ready to find your perfect match?* 💫

आपका जीवनसाथी आपका इंतज़ार कर रहा है!
Your life partner is waiting for you!

✨ *Benefits of joining ${BRAND_NAME}:*
✅ Create your profile in minutes
✅ Find matches based on your preference
✅ Connect with genuine people
✅ Safe and secure platform

*Let's begin your beautiful journey!*
*अपनी खूबसूरत यात्रा शुरू करें!* 🚀`;

const ENGAGING_SEARCH_MSG = `🔍 *Let's find your soulmate!* 🔍

आपके लिए सही रिश्ता ढूंढने का समय आ गया है!
Time to find the right relationship for you!

👉 *Choose Bride or Groom to begin*
*शुरू करने के लिए वधू या वर चुनें*

💖 Your perfect match is just a click away!`;

const NO_MATCHES_MSG = `😔 *No matches found at this moment* 😔

कोई match नहीं मिला इस समय।

💫 *Don't worry! Here's what you can do:*
• Try different preferences
• Check back later as new profiles join daily
• Create your profile to get discovered

👇 *Start a new search* 👇`;

const AFTER_REGISTRATION_MSG = `🎉 *Congratulations! आपका रजिस्ट्रेशन सफल हुआ!* 🎉

✨ *Profile Created Successfully!* ✨

💍 *${BRAND_NAME}* में आपका स्वागत है!
Welcome to ${BRAND_NAME}!

🌟 *What's Next? आगे क्या?*

1️⃣ *Make Payment* - Activate your account
2️⃣ *Start Searching* - Find your perfect match
3️⃣ *Connect* - Send interest and view contacts

*Choose an option below नीचे एक विकल्प चुनें* 👇`;

const PAYMENT_REQUIRED_MSG = `💝 *Unlock Premium Features!* 💝

❌ *Please make payment to send interest and view contact details*

✨ *Premium Plans:*

💰 *Approved 1* (Send Interest only):
   • ₹300 for 3 months
   • ₹1000 for 1 year

💰 *Approved 2* (Send Interest + View Contact):
   • ₹2000 for 1 year

🎁 *Special Benefits:*
• Unlimited Interest sending
• View complete contact details
• Priority in search results
• 24/7 support

👇 *Choose an option* 👇`;

const COMMANDS_MSG = `📘 *${BRAND_NAME}* — How it works
यहाँ सब कुछ WhatsApp पर easy तरीके से होता है।

*🔹 Basic Commands / मूल कमांड्स:*

*JOIN* → Create profile | नई प्रोफाइल बनाइए
*SEARCH* → Find matches | रिश्ते खोजिए
*MYPROFILES* → View your profiles | अपनी प्रोफाइल्स देखिए
*DELETE MH-XXXX* → Delete profile | प्रोफाइल delete कीजिए
*STOP* → Stop current process | प्रक्रिया बंद कीजिए

*🔸 Premium Commands (After Payment):*

*DETAILS MH-XXXX* → View profile details
*INTEREST MH-XXXX* → Show interest

💡 *Tip:* Type any command anytime to use!

💰 *Paid features:* SEND INTEREST and VIEW CONTACT DETAILS
सिर्फ paid users ही INTEREST और CONTACT DETAILS use कर सकते हैं।`;

const PENDING_MSG = `⏳ *Profile Under Review* ⏳

💍 *${BRAND_NAME}*

आपका प्रोफाइल अभी approve नहीं हुआ है।
Your profile is pending approval.

📌 *What to do?*
• Complete payment to get instant approval
• Admin will verify and approve within 24 hours
• You can still *SEARCH* for matches while waiting!

👇 *Choose an option* 👇`;

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
        text: { body: trimTo(body, 4096) },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );
    console.log("sendText success");
  } catch (err) {
    console.error("sendText failed:", err?.response?.data || err.message);
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
      image: { link: imageLink, ...(caption ? { caption: trimTo(caption, 4096) } : {}) },
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
        body: { text: trimTo(body, 1024) },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: {
              id: String(b.id).slice(0, 256),
              title: String(b.title).slice(0, 20),
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
        body: { text: trimTo(body, 1024) },
        action: {
          button: trimTo(buttonText || "Select", 20),
          sections: [
            {
              title: trimTo(sectionTitle, 24),
              rows: rows.map((r) => ({
                id: String(r.id).slice(0, 256),
                title: String(r.title).slice(0, 24),
                ...(r.description ? { description: String(r.description).slice(0, 72) } : {}),
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

async function sendJoinSearchStopButtons(to, body = "👇 *Choose an option* / *एक विकल्प चुनें* 👇") {
  await sendButtons(to, body, [
    { id: "JOIN", title: "📝 JOIN" },
    { id: "SEARCH", title: "🔍 SEARCH" },
    { id: "STOP", title: "⏹️ STOP" },
  ]);
}

async function sendPaymentButtons(to, body) {
  await sendButtons(to, body, [
    { id: "MAKE_PAYMENT", title: "💳 MAKE PAYMENT" },
    { id: "SEARCH", title: "🔍 SEARCH" },
    { id: "START_AGAIN", title: "🏠 START AGAIN" },
  ]);
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
    range: `${PROFILE_TAB}!A:X`,
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
    approved_1: cleanUpper(row?.[18] || ""),
    approved_1_expiry: row?.[19] || "",
    approved_2: cleanUpper(row?.[20] || ""),
    approved_2_expiry: row?.[21] || "",
    created_at: row?.[22] || "",
    marital_status: row?.[23] || "",
  };
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

async function updateProfileApproval1(rowIndex1Based, status, expiryDate) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!S${rowIndex1Based}:T${rowIndex1Based}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status, expiryDate || ""]] },
  });
}

async function updateProfileApproval2(rowIndex1Based, status, expiryDate) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!U${rowIndex1Based}:V${rowIndex1Based}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status, expiryDate || ""]] },
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
    "PENDING",  // approved_1
    "",         // approved_1_expiry
    "PENDING",  // approved_2
    "",         // approved_2_expiry
    createdAt,
    temp.marital_status || "",
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:X`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  return profile_id;
}

function getUserPaymentStatus(profile) {
  const approved1 = profile.approved_1;
  const approved1Expiry = profile.approved_1_expiry;
  const approved2 = profile.approved_2;
  const approved2Expiry = profile.approved_2_expiry;

  const canSendInterest = (approved1 === "APPROVED" && !isExpired(approved1Expiry)) ||
                          (approved2 === "APPROVED" && !isExpired(approved2Expiry));
  
  const canViewContact = (approved2 === "APPROVED" && !isExpired(approved2Expiry));

  return { canSendInterest, canViewContact };
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

  const msg = `🆕 *New Registration*

💍 *${BRAND_NAME}*

ID: *${profileId}*
Phone: ${phone}

Name: ${(temp?.name || "")} ${(temp?.surname || "")}
Gender: ${temp?.gender || ""}
Marital: ${temp?.marital_status || ""}

Native: ${temp?.native_place || ""}
Work: ${temp?.work_city || ""}

💰 User needs to make payment to activate features.`;

  await sendText(ADMIN_PHONE, msg);
}

async function notifyAdminPayment(userPhone, profileId, planType) {
  if (!ADMIN_PHONE) return;

  let planMsg = "";
  let buttons = [];

  if (planType === "PLAN_1_3MO") {
    planMsg = "Plan: APPROVED 1 - ₹300 for 3 months (Interest only)";
    buttons = [
      { id: `ADMIN_APPROVE_1_3MO_${profileId}_${userPhone}`, title: "✅ APPROVE 1 (3mo)" },
      { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "❌ REJECT" },
    ];
  } else if (planType === "PLAN_1_YEAR") {
    planMsg = "Plan: APPROVED 1 - ₹1000 for 1 year (Interest only)";
    buttons = [
      { id: `ADMIN_APPROVE_1_YEAR_${profileId}_${userPhone}`, title: "✅ APPROVE 1 (1yr)" },
      { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "❌ REJECT" },
    ];
  } else if (planType === "PLAN_2_YEAR") {
    planMsg = "Plan: APPROVED 2 - ₹2000 for 1 year (Interest + Contact)";
    buttons = [
      { id: `ADMIN_APPROVE_2_YEAR_${profileId}_${userPhone}`, title: "✅ APPROVE 2" },
      { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "❌ REJECT" },
    ];
  }

  const msg = `💰 *Payment Received*

User Phone: ${userPhone}
Profile ID: ${profileId}
${planMsg}

Please verify and approve.`;

  await sendText(ADMIN_PHONE, msg);
  await sendButtons(ADMIN_PHONE, `Action for ${profileId}`, buttons);
}

// ===================== Search Helpers =====================
function buildProfileCardForSearch(p) {
  const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
  const ageTxt = age !== null ? `${age}` : "NA";
  
  return `💖 *Profile ${p.profile_id}* 💖

🎂 Age: ${ageTxt}
📏 Height: ${p.height || "NA"}
🎓 Education: ${p.education || "NA"}
💼 Job: ${p.job_title || p.job || "NA"}
💍 Marital Status: ${p.marital_status || "NA"}
🏠 Native: ${p.native_place || "NA"}
🏢 Work: ${p.work_city || "NA"}

💫 *Interested? Click SELECT below!*`;
}

// UPDATED: Show ALL profiles (PENDING + APPROVED) in search results
async function getAllVisibleProfiles() {
  const rows = await getAllProfilesRows();
  const allProfiles = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = profileRowToObj(rows[i], i + 1);
    // Include ALL profiles regardless of approval status
    // Only exclude if explicitly REJECTED
    const isRejected = (obj.approved_1 === "REJECTED" && obj.approved_2 === "REJECTED");
    if (!isRejected) {
      allProfiles.push(obj);
    }
  }
  return allProfiles;
}

function applyFiltersToVisibleProfiles(allProfiles, opts) {
  const out = [];

  for (const p of allProfiles) {
    // Don't show rejected profiles
    if (p.approved_1 === "REJECTED" && p.approved_2 === "REJECTED") continue;

    const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
    if (age === null || age < MIN_AGE) continue;

    if (opts.excludeProfileId && p.profile_id === opts.excludeProfileId) continue;
    if (opts.targetGender && cleanLower(p.gender) !== cleanLower(opts.targetGender)) continue;

    out.push(p);
  }

  return out;
}

// ===================== GLOBAL handleDirectCommand FIXED (moved outside webhook) =====================
async function handleDirectCommand(from, cmd, args, temp, st) {
  // ===================== ADMIN COMMANDS =====================
  if (cmd === "APPROVE" || cmd === "REJECT") {
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
    
    if (cmd === "APPROVE") {
      await updateProfileApproval1(prof.rowIndex, newStatus, addYears(nowISO(), 1));
      await sendText(
        prof.phone,
        `🎉 *Congratulations!* 🎉

Your profile *${profileId}* is now *APPROVED*!

✨ *बधाई हो!* आपकी profile अब APPROVED है।

💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

👉 *You can now send interest to matches!*
*अब आप matches को interest भेज सकते हैं!*`
      );
      await sendButtons(prof.phone, "What would you like to do?", [
        { id: "SEARCH", title: "🔍 SEARCH" },
        { id: "MYPROFILES", title: "📋 MYPROFILES" },
      ]);
      await sendText(from, `✅ Approved ${profileId}`);
    } else {
      await sendText(
        prof.phone,
        `❌ *Profile Rejected*

Your profile *${profileId}* was rejected.

*आपकी profile reject कर दी गई है।*

👉 You can delete it and create a new one.
*आप इसे delete करके नई profile बना सकते हैं।*`
      );
      await sendButtons(prof.phone, "Next step", [
        { id: "MYPROFILES", title: "📋 MYPROFILES" },
        { id: `SELF_DELETE_${profileId}`, title: "🗑️ DELETE" },
      ]);
      await sendText(from, `✅ Rejected ${profileId}`);
    }
    return;
  }

  // ===================== MYPROFILES =====================
  if (cmd === "MYPROFILES") {
    const profiles = await findProfilesByPhone(from);
    if (!profiles.length) {
      await sendText(from, WELCOME_MSG);
      await sendJoinSearchStopButtons(from);
      return;
    }

    const lines = profiles.map((p) => `• ${p.profile_id} (${p.approved_1 === "APPROVED" ? "✅ ACTIVE" : "⏳ PENDING"})`).join("\n");
    await sendText(
      from,
      `💍 *${BRAND_NAME}*

📋 *Your Profiles / आपकी profiles*

${lines}

👇 *Select a profile for DETAILS / DELETE*`
    );

    await sendList(
      from,
      "Choose your profile\nअपनी profile चुनिए",
      "Select",
      profiles.slice(0, 10).map((p) => ({
        id: `MYPROFILE_${p.profile_id}`,
        title: p.profile_id,
        description: `${p.approved_1 === "APPROVED" ? "ACTIVE" : "PENDING"} | ${p.marital_status || "NA"}`,
      })),
      "My Profiles"
    );

    await sendButtons(from, "⚡ *Quick actions* / *जल्दी वाले options*", [
      { id: "JOIN", title: "📝 JOIN" },
      { id: "SEARCH", title: "🔍 SEARCH" },
      { id: "STOP", title: "⏹️ STOP" },
    ]);
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
      await sendText(from, "❌ You can delete only your own profile.\nआप सिर्फ अपनी profile delete कर सकते हैं।");
      return;
    }

    await deleteProfileRow(prof.rowIndex);
    await setState(from, "", {});
    await sendText(from, `✅ *Deleted ${profileId}* ✅\n\n${profileId} delete हो गया।`);
    await sendJoinSearchStopButtons(from, "What would you like to do next?\nअब आगे क्या करना है?");
    return;
  }

  // ===================== SEARCH (New Flow) =====================
  if (cmd === "SEARCH") {
    await sendText(from, ENGAGING_SEARCH_MSG);
    await setState(from, "SEARCH_BRIDE_GROOM", {});
    await sendButtons(from, "👰 *Select Bride* OR 🤵 *Select Groom*\n\n*वधू या वर चुनें* 👇", [
      { id: "SEARCH_BRIDE", title: "👰 BRIDE" },
      { id: "SEARCH_GROOM", title: "🤵 GROOM" },
      { id: "STOP", title: "⏹️ STOP" },
    ]);
    return;
  }

  // ===================== NEXT for search =====================
  if (cmd === "NEXT") {
    if (!temp.searchResults || !Array.isArray(temp.searchResults) || !temp.searchResults.length) {
      await sendText(from, "🔍 *No search active. Please start a new search.*\n\n*कोई search active नहीं है। नई search शुरू करें।*");
      await sendButtons(from, "Start a new search?", [
        { id: "SEARCH", title: "🔍 SEARCH" },
      ]);
      return;
    }

    let currentIndex = (temp.searchIndex || 0) + 1;
    if (currentIndex >= temp.searchResults.length) {
      currentIndex = 0;
    }
    temp.searchIndex = currentIndex;
    await setState(from, "SEARCH_RESULTS_VIEW", temp);
    await showProfileCard(from, temp.searchResults[currentIndex], temp);
    return;
  }

  // ===================== DETAILS =====================
  if (cmd === "DETAILS") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) {
      await sendText(from, "Use: DETAILS MH-XXXX");
      return;
    }

    const target = await findProfileById(profileId);
    if (!target) {
      await sendText(from, "Profile not found.\nProfile नहीं मिली।");
      return;
    }

    const age = calcAgeFromDobDDMMYYYY(target.date_of_birth);
    const cap = `💍 *${BRAND_NAME}*

📄 *Profile Details*
*प्रोफाइल जानकारी*

🆔 ID: ${target.profile_id}
⚥ Gender: ${target.gender}
💍 Marital Status: ${target.marital_status || "NA"}
🎂 Age: ${age !== null ? age : "NA"}

🏠 Native: ${target.native_place || "NA"}, ${target.district || "NA"}
🏢 Work: ${target.work_city || "NA"}, ${target.work_district || "NA"}

🕉️ Religion: ${target.religion || "NA"}
👥 Caste: ${target.caste || "NA"}
📏 Height: ${target.height || "NA"}

🎓 Education: ${target.education || "NA"}
💼 Job Type: ${target.job || "NA"}
📌 Job Title: ${target.job_title || "NA"}
💰 Income: ${target.income_annual || "NA"}`;

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

    const userProfiles = await findProfilesByPhone(from);
    if (!userProfiles.length) {
      await sendPaymentRequiredMessage(from);
      return;
    }

    const userProfile = userProfiles[0];
    const { canSendInterest } = getUserPaymentStatus(userProfile);

    if (!canSendInterest) {
      await sendPaymentRequiredMessage(from);
      return;
    }

    if (userProfile.profile_id === profileId) {
      await sendText(from, "❌ You cannot send INTEREST to your own profile.");
      return;
    }

    const target = await findProfileById(profileId);
    if (!target) {
      await sendText(from, "Profile not found.");
      return;
    }

    const existing = await findInterestRequest({
      from_profile_id: userProfile.profile_id,
      to_profile_id: target.profile_id,
    });

    if (existing && ["SENT", "ACCEPTED"].includes(existing.status)) {
      await sendText(from, "💌 *You already showed interest in this profile.*\n\n*आप पहले ही इस profile पर interest भेज चुके हैं।*");
      return;
    }

    await appendRequest({
      from_profile_id: userProfile.profile_id,
      to_profile_id: target.profile_id,
      status: "SENT",
      type: "INTEREST",
      viewer_phone: from,
    });

    await sendButtons(
      target.phone,
      `💌 *${BRAND_NAME}*

✨ *Someone showed interest in you!*
*किसी ने आपके profile में interest दिखाया है!*

📌 Interested Profile ID: *${userProfile.profile_id}*

👇 *Choose an option* / *कृपया एक विकल्प चुनें* 👇`,
      [
        { id: `ACCEPT_${userProfile.profile_id}`, title: "✅ ACCEPT" },
        { id: `REJECT_${userProfile.profile_id}`, title: "❌ REJECT" },
        { id: `DETAILS_${userProfile.profile_id}`, title: "📄 DETAILS" },
      ]
    );

    await sendText(from, `✅ *Interest sent to ${target.profile_id}!* ✅\n\n*Interest भेज दिया गया है।*`);
    return;
  }

  // ===================== ACCEPT / REJECT =====================
  if (cmd === "ACCEPT" || cmd === "REJECT") {
    const interestedProfileId = normalizeProfileId(args[0]);
    if (!interestedProfileId) {
      await sendText(from, "Use: ACCEPT MH-XXXX  OR  REJECT MH-XXXX");
      return;
    }

    const receiverProfiles = await findProfilesByPhone(from);
    if (!receiverProfiles.length) {
      await sendText(from, PENDING_MSG);
      return;
    }
    const receiverActive = receiverProfiles[0];

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
      await sendText(from, `❌ *Rejected interest from ${interestedProfileId}.*`);
      await sendText(senderProfile.phone, `❌ *Your interest was rejected by ${receiverActive.profile_id}.*\n\n*आपका interest reject कर दिया गया है।*`);
      return;
    }

    const { canViewContact } = getUserPaymentStatus(receiverActive);
    
    await sendText(from, `✅ *Accepted interest from ${interestedProfileId}!* ✅`);
    
    if (canViewContact) {
      await sendText(from, `📞 *Contact Shared!* 📞

Profile: ${interestedProfileId}
Phone: ${senderProfile.phone}

💫 *Connect and start your beautiful journey together!*`);
      
      await sendText(
        senderProfile.phone,
        `🎉 *Your interest was accepted!* 🎉

📞 *Contact Shared:* 
Profile: ${receiverActive.profile_id}
Phone: ${receiverActive.phone}

💖 *Wishing you a wonderful journey ahead!*`
      );
    } else {
      await sendText(from, `⚠️ *You need APPROVED 2 plan to view contact details.*

Upgrade to view complete contact information.`);
      
      await sendText(
        senderProfile.phone,
        `🎉 *Your interest was accepted!* 🎉

The user will contact you soon.
*आपसे जल्द ही संपर्क किया जाएगा।*`
      );
    }
    return;
  }
}

// ===================== Helper Functions =====================
async function sendPaymentRequiredMessage(to) {
  await sendText(to, PAYMENT_REQUIRED_MSG);
  await sendButtons(to, "👇 *Choose an option* 👇", [
    { id: "JOIN", title: "📝 JOIN" },
    { id: "SEARCH", title: "🔍 SEARCH" },
  ]);
}

async function showProfileCard(to, profile, temp) {
  const msg = buildProfileCardForSearch(profile);
  
  if (profile.photo_url) {
    await sendImageByLink(to, profile.photo_url, msg);
  } else {
    await sendText(to, msg);
  }

  temp.currentViewingProfile = profile;
  await setState(to, "SEARCH_RESULTS_VIEW", temp);
  
  await sendButtons(to, "👇 *What would you like to do?* / *आप क्या करना चाहेंगे?* 👇", [
    { id: "SELECT_ACTION", title: "🎯 SELECT" },
    { id: "FILTER_SEARCH", title: "🔧 FILTER SEARCH" },
    { id: "NEXT", title: "⏩ NEXT" },
  ]);
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

    console.log("📩 Incoming Message from:", from);
    console.log("Type:", msgType);
    console.log("Text:", text);
    console.log("Interactive ID:", interactiveId);

    const st = await getState(from);
    const temp = safeJsonParse(st.temp_data || "{}", {});
    let effectiveInput = text || interactiveId || "";

    // Handle interactive button commands
    if (interactiveId.startsWith("ACCEPT_")) {
      effectiveInput = `ACCEPT ${interactiveId.replace("ACCEPT_", "")}`;
    } else if (interactiveId.startsWith("REJECT_")) {
      effectiveInput = `REJECT ${interactiveId.replace("REJECT_", "")}`;
    } else if (interactiveId.startsWith("DETAILS_")) {
      effectiveInput = `DETAILS ${interactiveId.replace("DETAILS_", "")}`;
    } else if (interactiveId === "SELECT_ACTION") {
      effectiveInput = "SELECT_ACTION";
    } else if (interactiveId === "FILTER_SEARCH") {
      effectiveInput = "FILTER_SEARCH";
    } else if (interactiveId === "SEARCH_BRIDE") {
      effectiveInput = "SEARCH_BRIDE";
    } else if (interactiveId === "SEARCH_GROOM") {
      effectiveInput = "SEARCH_GROOM";
    } else if (interactiveId === "MAKE_PAYMENT") {
      effectiveInput = "MAKE_PAYMENT";
    } else if (interactiveId === "START_AGAIN") {
      effectiveInput = "START_AGAIN";
    } else if (interactiveId === "SEND_INTEREST") {
      effectiveInput = "SEND_INTEREST";
    } else if (interactiveId === "VIEW_CONTACT") {
      effectiveInput = "VIEW_CONTACT";
    } else if (interactiveId.startsWith("ADMIN_APPROVE_1_3MO_")) {
      const parts = interactiveId.replace("ADMIN_APPROVE_1_3MO_", "").split("_");
      const profileId = parts[0];
      const userPhone = parts[1];
      effectiveInput = `ADMIN_APPROVE_1_3MO ${profileId} ${userPhone}`;
    } else if (interactiveId.startsWith("ADMIN_APPROVE_1_YEAR_")) {
      const parts = interactiveId.replace("ADMIN_APPROVE_1_YEAR_", "").split("_");
      const profileId = parts[0];
      const userPhone = parts[1];
      effectiveInput = `ADMIN_APPROVE_1_YEAR ${profileId} ${userPhone}`;
    } else if (interactiveId.startsWith("ADMIN_APPROVE_2_YEAR_")) {
      const parts = interactiveId.replace("ADMIN_APPROVE_2_YEAR_", "").split("_");
      const profileId = parts[0];
      const userPhone = parts[1];
      effectiveInput = `ADMIN_APPROVE_2_YEAR ${profileId} ${userPhone}`;
    } else if (interactiveId.startsWith("ADMIN_REJECT_")) {
      const parts = interactiveId.replace("ADMIN_REJECT_", "").split("_");
      const profileId = parts[0];
      const userPhone = parts[1];
      effectiveInput = `ADMIN_REJECT ${profileId} ${userPhone}`;
    }

    const { cmd, args } = parseCommand(effectiveInput);

    // ===================== VIVAHO HOME =====================
    if (interactiveId === "VIVAHO_HOME" || cmd === "VIVAHO_HOME" || (!st.step && !interactiveId && !cmd)) {
      await sendText(from, WELCOME_MSG);
      await sendText(from, COMMANDS_MSG);
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== GREETINGS / START =====================
    if (isGreeting(text)) {
      await sendText(from, WELCOME_MSG);
      await sendText(from, COMMANDS_MSG);
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== GLOBAL BUTTON ACTIONS =====================
    if (interactiveId === "JOIN" || cmd === "JOIN") {
      const existing = await findProfilesByPhone(from);
      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        const latest = existing[0];
        await sendText(
          from,
          `⚠️ *You already have ${existing.length} profile (max ${MAX_PROFILES_PER_PHONE}).*
*आपके पास पहले से ${existing.length} profile है।*

📌 Profile: ${latest.profile_id}

👇 *What would you like to do?*`
        );
        await sendButtons(
          from,
          "Choose an option:",
          [
            { id: `SELF_DELETE_${latest.profile_id}`, title: "🗑️ DELETE" },
            { id: `DETAILS_${latest.profile_id}`, title: "📄 DETAILS" },
            { id: "SEARCH", title: "🔍 SEARCH" },
          ]
        );
        return;
      }
      await sendText(from, ENGAGING_JOIN_MSG);
      await sendText(from, COMMANDS_MSG);
      await setState(from, "ASK_NAME", {});
      await sendText(from, getPromptByStep("ASK_NAME"));
      return;
    }

    if (interactiveId === "STOP" || cmd === "STOP") {
      await setState(from, "", {});
      await sendText(from, "✅ *Process stopped.* / *प्रक्रिया बंद कर दी गई है।*\n\n*Type JOIN or SEARCH to continue.*");
      await sendJoinSearchStopButtons(from);
      return;
    }

    if (interactiveId === "SEARCH" || cmd === "SEARCH") {
      await handleDirectCommand(from, "SEARCH", [], temp, st);
      return;
    }

    if (interactiveId === "MYPROFILES" || cmd === "MYPROFILES") {
      await handleDirectCommand(from, "MYPROFILES", [], temp, st);
      return;
    }

    if (interactiveId.startsWith("SELF_DELETE_")) {
      const profileId = normalizeProfileId(interactiveId.replace("SELF_DELETE_", ""));
      await handleDirectCommand(from, "DELETE", [profileId], temp, st);
      return;
    }

    if (interactiveId.startsWith("MYPROFILE_")) {
      const profileId = normalizeProfileId(interactiveId.replace("MYPROFILE_", ""));
      const prof = await findProfileById(profileId);
      if (prof) {
        await sendButtons(from, `📌 *Selected Profile: ${profileId}*`, [
          { id: `DETAILS_${profileId}`, title: "📄 DETAILS" },
          { id: `SELF_DELETE_${profileId}`, title: "🗑️ DELETE" },
          { id: "MYPROFILES", title: "🔙 BACK" },
        ]);
      }
      return;
    }

    // ===================== SEARCH BRIDE/GROOM SELECTION =====================
    if (effectiveInput === "SEARCH_BRIDE" || effectiveInput === "SEARCH_GROOM") {
      const targetGender = effectiveInput === "SEARCH_BRIDE" ? "female" : "male";
      const allVisible = await getAllVisibleProfiles();
      
      const results = applyFiltersToVisibleProfiles(allVisible, {
        targetGender: targetGender,
        excludeProfileId: null,
      });

      if (!results.length) {
        await sendText(from, NO_MATCHES_MSG);
        await sendButtons(from, "👇 *What would you like to do?*", [
          { id: "SEARCH", title: "🔍 SEARCH AGAIN" },
          { id: "JOIN", title: "📝 CREATE PROFILE" },
        ]);
        return;
      }

      temp.searchResults = results;
      temp.searchIndex = 0;
      await setState(from, "SEARCH_RESULTS_VIEW", temp);
      await showProfileCard(from, results[0], temp);
      return;
    }

    // ===================== SELECT ACTION (SEND INTEREST / VIEW CONTACT) =====================
    if (effectiveInput === "SELECT_ACTION") {
      if (!temp.currentViewingProfile) {
        await sendText(from, "🔍 *No profile selected. Please start a new search.*");
        await sendButtons(from, "Start a new search?", [
          { id: "SEARCH", title: "🔍 SEARCH" },
        ]);
        return;
      }

      await sendButtons(from, `💖 *What would you like to do with ${temp.currentViewingProfile.profile_id}?* 💖`, [
        { id: "SEND_INTEREST", title: "💌 SEND INTEREST" },
        { id: "VIEW_CONTACT", title: "📞 VIEW CONTACT" },
      ]);
      return;
    }

    if (effectiveInput === "SEND_INTEREST") {
      if (!temp.currentViewingProfile) {
        await sendText(from, "No profile selected.");
        return;
      }
      await handleDirectCommand(from, "INTEREST", [temp.currentViewingProfile.profile_id], temp, st);
      return;
    }

    if (effectiveInput === "VIEW_CONTACT") {
      if (!temp.currentViewingProfile) {
        await sendText(from, "No profile selected.");
        return;
      }
      
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendPaymentRequiredMessage(from);
        return;
      }

      const userProfile = userProfiles[0];
      const { canViewContact } = getUserPaymentStatus(userProfile);

      if (!canViewContact) {
        await sendPaymentRequiredMessage(from);
        return;
      }

      const targetProfile = temp.currentViewingProfile;
      await sendText(from, `📞 *Contact Details* 📞

👤 Profile: ${targetProfile.profile_id}
📱 Phone: ${targetProfile.phone}

💫 *Connect and start your journey together!*`);
      return;
    }

    // ===================== FILTER SEARCH (Old detailed search) =====================
    if (effectiveInput === "FILTER_SEARCH") {
      await setState(from, "SEARCH_CITY_SCOPE", {});
      await sendButtons(from, "📍 *Native place preference*\n\n*Native place के लिए preference चुनें*", [
        { id: "SEARCH_NATIVE_SAME", title: "🏠 SAME NATIVE" },
        { id: "SEARCH_NATIVE_ANY", title: "🌍 ANY NATIVE" },
      ]);
      return;
    }

    // ===================== MAKE PAYMENT =====================
    if (effectiveInput === "MAKE_PAYMENT") {
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendText(from, "📝 *Please create a profile first using JOIN.*\n\n*पहले JOIN करके प्रोफाइल बनाएं।*");
        await sendButtons(from, "Create profile now?", [
          { id: "JOIN", title: "📝 JOIN" },
        ]);
        return;
      }

      const userProfile = userProfiles[0];
      temp.pendingPaymentProfile = userProfile.profile_id;
      await setState(from, "PAYMENT_SELECT_PLAN", temp);
      
      await sendButtons(from, "💰 *Choose your payment plan* / *अपना प्लान चुनें* 💰", [
        { id: "PLAN_1_3MO", title: "₹300 (3 months)" },
        { id: "PLAN_1_YEAR", title: "₹1000 (1 year)" },
        { id: "PLAN_2_YEAR", title: "₹2000 (1 year)" },
      ]);
      return;
    }

    if (effectiveInput === "PLAN_1_3MO" || effectiveInput === "PLAN_1_YEAR" || effectiveInput === "PLAN_2_YEAR") {
      const planType = effectiveInput;
      temp.selectedPlan = planType;
      await setState(from, "PAYMENT_QR", temp);
      
      const planMsg = planType === "PLAN_1_3MO" ? "₹300 for 3 months" : 
                      planType === "PLAN_1_YEAR" ? "₹1000 for 1 year" : "₹2000 for 1 year";
      
      await sendText(from, `💰 *Payment Amount: ${planMsg}*

📱 *UPI ID:* ${UPI_ID}

📸 *Instructions:*
1. Make payment using UPI
2. Take a screenshot
3. Click "I HAVE PAID" below

*निर्देश:*
1. UPI से भुगतान करें
2. स्क्रीनशॉट लें
3. नीचे "I HAVE PAID" क्लिक करें`);
      
      if (QR_IMAGE_URL) {
        await sendImageByLink(from, QR_IMAGE_URL, "Scan to Pay | पेमेंट करें");
      }
      
      await sendButtons(from, "✅ *After payment, click below*", [
        { id: "PAYMENT_DONE", title: "✅ I HAVE PAID" },
        { id: "CANCEL", title: "❌ CANCEL" },
      ]);
      return;
    }

    if (effectiveInput === "PAYMENT_DONE") {
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) return;
      
      const userProfile = userProfiles[0];
      const planType = temp.selectedPlan || "PLAN_1_YEAR";
      
      await notifyAdminPayment(from, userProfile.profile_id, planType);
      await sendText(from, `✅ *Payment notification sent to admin!*

📌 Your payment is being verified.
You will be approved shortly.

*आपका payment verify किया जा रहा है।
जल्द ही आपको approve कर दिया जाएगा।*

⏳ *Please wait for admin approval.*`);
      
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from);
      return;
    }

    if (effectiveInput === "CANCEL") {
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from, "Payment cancelled. What would you like to do?");
      return;
    }

    // ===================== ADMIN PAYMENT APPROVAL =====================
    if (cmd === "ADMIN_APPROVE_1_3MO" || cmd === "ADMIN_APPROVE_1_YEAR" || cmd === "ADMIN_APPROVE_2_YEAR" || cmd === "ADMIN_REJECT") {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can approve payments.");
        return;
      }

      const profileId = args[0];
      const userPhone = args[1];
      const prof = await findProfileById(profileId);
      
      if (!prof) {
        await sendText(from, "Profile not found.");
        return;
      }

      if (cmd === "ADMIN_REJECT") {
        await sendText(userPhone, `❌ *Payment Verification Failed*

Your payment could not be verified.
Please contact admin or try again.

*आपका payment verify नहीं हो सका।
कृपया admin से संपर्क करें या पुनः प्रयास करें।*`);
        await sendText(from, `✅ Rejected payment for ${userPhone}`);
        return;
      }

      let expiryDate = "";
      let planMsg = "";
      
      if (cmd === "ADMIN_APPROVE_1_3MO") {
        expiryDate = addMonths(nowISO(), 3);
        await updateProfileApproval1(prof.rowIndex, "APPROVED", expiryDate);
        planMsg = "✅ *APPROVED 1 Plan Activated!* (₹300 for 3 months)\n\n✨ *You can now SEND INTEREST to profiles!*";
      } else if (cmd === "ADMIN_APPROVE_1_YEAR") {
        expiryDate = addYears(nowISO(), 1);
        await updateProfileApproval1(prof.rowIndex, "APPROVED", expiryDate);
        planMsg = "✅ *APPROVED 1 Plan Activated!* (₹1000 for 1 year)\n\n✨ *You can now SEND INTEREST to profiles!*";
      } else if (cmd === "ADMIN_APPROVE_2_YEAR") {
        expiryDate = addYears(nowISO(), 1);
        await updateProfileApproval1(prof.rowIndex, "APPROVED", expiryDate);
        await updateProfileApproval2(prof.rowIndex, "APPROVED", expiryDate);
        planMsg = "✅ *APPROVED 2 Plan Activated!* (₹2000 for 1 year)\n\n✨ *You can now SEND INTEREST and VIEW CONTACT DETAILS!*";
      }

      await sendText(userPhone, `🎉 *Payment Verified Successfully!* 🎉

${planMsg}

💝 *Thank you for choosing ${BRAND_NAME}!*
*${BRAND_NAME} चुनने के लिए धन्यवाद!*

👇 *Start searching for your perfect match now!*`);
      
      await sendButtons(userPhone, "Get started:", [
        { id: "SEARCH", title: "🔍 SEARCH" },
        { id: "MYPROFILES", title: "📋 MYPROFILES" },
      ]);
      
      await sendText(from, `✅ Approved ${profileId} for ${userPhone} (${cmd})`);
      return;
    }

    if (effectiveInput === "START_AGAIN") {
      await setState(from, "", {});
      await sendText(from, "✨ *Welcome back to ${BRAND_NAME}!* ✨");
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== REGISTRATION FLOW =====================
    if (st.step === "ASK_NAME") {
      if (!text) return;
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, getPromptByStep("ASK_SURNAME"));
      return;
    }

    if (st.step === "ASK_SURNAME") {
      if (!text) return;
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendButtons(from, "⚥ *Select Gender* / *लिंग चुनें*", [
        { id: "GENDER_MALE", title: "👨 MALE" },
        { id: "GENDER_FEMALE", title: "👩 FEMALE" },
      ]);
      return;
    }

    if (st.step === "ASK_GENDER") {
      let g = "";
      if (interactiveId === "GENDER_MALE") g = "male";
      else if (interactiveId === "GENDER_FEMALE") g = "female";
      else g = normalizeGender(text);

      if (!g) {
        await sendText(from, makeInvalidReplyMsg("Please select gender."));
        return;
      }

      temp.gender = g;
      await setState(from, "ASK_MARITAL_STATUS", temp);
      await sendList(
        from,
        "💍 *Your Marital Status* / *तुमची वैवाहिक स्थिती*",
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
      else ms = maritalStatusFromInput(text);

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
      if (!text) return;
      const age = calcAgeFromDobDDMMYYYY(text);
      if (age === null) {
        await sendText(from, makeInvalidReplyMsg(getPromptByStep("ASK_DOB")));
        return;
      }
      if (age < MIN_AGE) {
        await setState(from, "", {});
        await sendText(from, `❌ *Registration not allowed.*

Minimum age is ${MIN_AGE} years.
*न्यूनतम आयु ${MIN_AGE} वर्ष है।*`);
        return;
      }
      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, getPromptByStep("ASK_HEIGHT"));
      return;
    }

    if (st.step === "ASK_HEIGHT") {
      if (!text) return;
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, getPromptByStep("ASK_RELIGION"));
      return;
    }

    if (st.step === "ASK_RELIGION") {
      if (!text) return;
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, getPromptByStep("ASK_CASTE"));
      return;
    }

    if (st.step === "ASK_CASTE") {
      if (!text) return;
      temp.caste = text;
      await setState(from, "ASK_NATIVE_PLACE", temp);
      await sendText(from, getPromptByStep("ASK_NATIVE_PLACE"));
      return;
    }

    if (st.step === "ASK_NATIVE_PLACE") {
      if (!text) return;
      temp.native_place = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, getPromptByStep("ASK_DISTRICT"));
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      if (!text) return;
      temp.district = text;
      await setState(from, "ASK_WORK_CITY", temp);
      await sendText(from, getPromptByStep("ASK_WORK_CITY"));
      return;
    }

    if (st.step === "ASK_WORK_CITY") {
      if (!text) return;
      if (isSame(text)) temp.work_city = temp.native_place || "";
      else temp.work_city = text;
      await setState(from, "ASK_WORK_DISTRICT", temp);
      await sendText(from, getPromptByStep("ASK_WORK_DISTRICT"));
      return;
    }

    if (st.step === "ASK_WORK_DISTRICT") {
      if (!text) return;
      if (isSkip(text)) temp.work_district = "";
      else if (isSame(text)) temp.work_district = temp.district || "";
      else temp.work_district = text;
      await setState(from, "ASK_EDU", temp);
      await sendText(from, getPromptByStep("ASK_EDU"));
      return;
    }

    if (st.step === "ASK_EDU") {
      if (!text) return;
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendButtons(from, "💼 *Select Job Type* / *नौकरी का प्रकार चुनें*", [
        { id: "JOB_GOVT", title: "🏛️ GOVERNMENT" },
        { id: "JOB_PRIVATE", title: "🏢 PRIVATE" },
        { id: "JOB_BUSINESS", title: "📈 BUSINESS" },
      ]);
      return;
    }

    if (st.step === "ASK_JOB") {
      let job = "";
      if (interactiveId === "JOB_GOVT") job = "Government";
      else if (interactiveId === "JOB_PRIVATE") job = "Private";
      else if (interactiveId === "JOB_BUSINESS") job = "Business";
      else {
        const x = cleanLower(text);
        if (x.includes("gov")) job = "Government";
        else if (x.includes("private")) job = "Private";
        else if (x.includes("business")) job = "Business";
      }

      if (!job) {
        await sendText(from, "Please select job type.");
        return;
      }

      temp.job = job;
      await setState(from, "ASK_JOB_TITLE", temp);
      await sendText(from, getPromptByStep("ASK_JOB_TITLE"));
      return;
    }

    if (st.step === "ASK_JOB_TITLE") {
      if (!text) return;
      temp.job_title = text;
      await setState(from, "ASK_INCOME", temp);
      await sendList(
        from,
        "💰 *Select Monthly Income* / *मासिक आय चुनें*",
        "Select",
        [
          { id: "INC_1", title: "Up to ₹50,000" },
          { id: "INC_2", title: "₹50K - ₹1L" },
          { id: "INC_3", title: "₹1L - ₹3L" },
          { id: "INC_4", title: "Above ₹3L" },
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
      else income = text;

      if (!income) {
        await sendText(from, "Please select income range.");
        return;
      }

      temp.income_annual = income;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, "📸 *" + getPromptByStep("ASK_PHOTO") + "*");
      return;
    }

    // ===================== PHOTO STEP =====================
    if (st.step === "ASK_PHOTO") {
      if (msgType !== "image") {
        await sendText(from, makeInvalidReplyMsg("📸 Please send a clear photo."));
        return;
      }

      const mediaId = msg.image?.id;
      if (!mediaId) {
        await sendText(from, "❌ Photo not received properly. Please send again.");
        return;
      }

      await sendText(from, "📸 *Photo received! Uploading...* / *फोटो मिल गई! अपलोड हो रही है...*");

      const metaUrl = await getMetaMediaUrl(mediaId);
      if (!metaUrl) {
        await sendText(from, "❌ Could not read photo. Please send again.");
        return;
      }

      let permanentLink = "";
      try {
        const { bytes } = await downloadMetaMediaBytes(metaUrl);
        const filename = `MH_${from}_${Date.now()}.jpg`;
        permanentLink = await uploadPhotoToCloudinary(bytes, filename);
      } catch (e) {
        console.error("Photo upload error:", e);
      }

      if (!permanentLink) {
        await sendText(from, "❌ Photo upload failed. Please send photo again later.");
        return;
      }

      temp.photo_url = permanentLink;
      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);

      await setState(from, "", {});
      
      // Send engaging registration completion message with payment options
      await sendText(from, AFTER_REGISTRATION_MSG);
      await sendPaymentButtons(from, "👇 *Choose an option* / *नीचे एक विकल्प चुनें* 👇");
      return;
    }

    // ===================== SEARCH FILTER FLOW (Old detailed search) =====================
    if (st.step === "SEARCH_CITY_SCOPE") {
      if (interactiveId === "SEARCH_NATIVE_SAME") {
        temp.cityScope = "SAME_CITY";
      } else if (interactiveId === "SEARCH_NATIVE_ANY") {
        temp.cityScope = "ANY";
      } else {
        await sendButtons(from, "📍 *Native place preference*", [
          { id: "SEARCH_NATIVE_SAME", title: "🏠 SAME NATIVE" },
          { id: "SEARCH_NATIVE_ANY", title: "🌍 ANY NATIVE" },
        ]);
        return;
      }
      await setState(from, "SEARCH_WORK_CITY_SCOPE", temp);
      await sendButtons(from, "🏢 *Work city preference*", [
        { id: "SEARCH_WORK_SAME", title: "🏠 SAME WORK" },
        { id: "SEARCH_WORK_ANY", title: "🌍 ANY CITY" },
      ]);
      return;
    }

    if (st.step === "SEARCH_WORK_CITY_SCOPE") {
      if (interactiveId === "SEARCH_WORK_SAME") {
        temp.workCityScope = "SAME_CITY";
      } else if (interactiveId === "SEARCH_WORK_ANY") {
        temp.workCityScope = "ANY";
      } else {
        await sendButtons(from, "🏢 *Work city preference*", [
          { id: "SEARCH_WORK_SAME", title: "🏠 SAME WORK" },
          { id: "SEARCH_WORK_ANY", title: "🌍 ANY CITY" },
        ]);
        return;
      }
      await setState(from, "SEARCH_AGE_RANGE", temp);
      await sendButtons(from, "🎂 *Age range preference* / *उम्र की preference*", [
        { id: "AGE_SKIP", title: "⏩ SKIP" },
      ]);
      await sendText(from, "📝 *Enter preferred age range*\n*पसंदीदा उम्र सीमा लिखें*\n\nExample / उदाहरण: *23-30*\nOr tap SKIP");
      return;
    }

    if (st.step === "SEARCH_AGE_RANGE") {
      if (interactiveId === "AGE_SKIP" || isSkip(text)) {
        temp.ageMin = 21;
        temp.ageMax = 40;
      } else {
        const m = text.match(/^(\d{2})-(\d{2})$/);
        if (!m) {
          await sendText(from, makeInvalidReplyMsg("Enter age range like 23-30"));
          return;
        }
        const a1 = parseInt(m[1], 10);
        const a2 = parseInt(m[2], 10);
        if (!a1 || !a2 || a1 < MIN_AGE || a2 < MIN_AGE || a1 > a2) {
          await sendText(from, `❌ Invalid age range. Minimum age must be ${MIN_AGE}+.`);
          return;
        }
        temp.ageMin = a1;
        temp.ageMax = a2;
      }
      await setState(from, "SEARCH_MARITAL_STATUS", temp);
      await sendList(
        from,
        "💍 *Marital status preference*",
        "Select",
        [
          { id: "SEARCH_MS_UNMARRIED", title: "Unmarried" },
          { id: "SEARCH_MS_DIVORCE", title: "Divorce" },
          { id: "SEARCH_MS_WIDOW", title: "Widower/Widow" },
          { id: "SEARCH_MS_ANY", title: "No Preference" },
        ],
        "Marital Status"
      );
      return;
    }

    if (st.step === "SEARCH_MARITAL_STATUS") {
      let ms = "";
      if (interactiveId === "SEARCH_MS_UNMARRIED") ms = "Unmarried";
      else if (interactiveId === "SEARCH_MS_DIVORCE") ms = "Divorce";
      else if (interactiveId === "SEARCH_MS_WIDOW") ms = "Widower/Widow";
      else if (interactiveId === "SEARCH_MS_ANY") ms = "ANY";
      else ms = "ANY";

      temp.maritalStatus = ms === "ANY" ? null : ms;
      await setState(from, "SEARCH_CASTE_SCOPE", temp);
      await sendButtons(from, "👥 *Caste preference* / *जात preference*", [
        { id: "SEARCH_CASTE_SAME", title: "🔄 SAME CASTE" },
        { id: "SEARCH_CASTE_ANY", title: "🌍 ANY CASTE" },
      ]);
      return;
    }

    if (st.step === "SEARCH_CASTE_SCOPE") {
      if (interactiveId === "SEARCH_CASTE_SAME") {
        temp.casteScope = "SAME_CASTE";
      } else if (interactiveId === "SEARCH_CASTE_ANY") {
        temp.casteScope = "ANY";
      } else {
        await sendButtons(from, "👥 *Caste preference*", [
          { id: "SEARCH_CASTE_SAME", title: "🔄 SAME CASTE" },
          { id: "SEARCH_CASTE_ANY", title: "🌍 ANY CASTE" },
        ]);
        return;
      }
      await setState(from, "SEARCH_EDU_MIN", temp);
      await sendButtons(from, "🎓 *Minimum education* / *Minimum शिक्षा*", [
        { id: "EDU_ANY", title: "📚 ANY" },
        { id: "EDU_GRAD", title: "🎓 GRADUATE" },
        { id: "EDU_POST", title: "📖 POSTGRAD" },
      ]);
      return;
    }

    if (st.step === "SEARCH_EDU_MIN") {
      let edu = "";
      if (interactiveId === "EDU_ANY") edu = "ANY";
      else if (interactiveId === "EDU_GRAD") edu = "GRADUATE";
      else if (interactiveId === "EDU_POST") edu = "POSTGRADUATE";
      else edu = "ANY";

      temp.eduMinRank = edu === "ANY" ? null : (edu === "GRADUATE" ? 2 : 3);
      await setState(from, "SEARCH_INCOME_MIN", temp);
      await sendList(
        from,
        "💰 *Minimum income preference*",
        "Select",
        [
          { id: "MININC_1", title: "Up to ₹50,000" },
          { id: "MININC_2", title: "₹50K - ₹1L" },
          { id: "MININC_3", title: "₹1L - ₹3L" },
          { id: "MININC_4", title: "Above ₹3L" },
          { id: "MININC_SKIP", title: "No Preference" },
        ],
        "Income Range"
      );
      return;
    }

    if (st.step === "SEARCH_INCOME_MIN") {
      if (interactiveId === "MININC_SKIP" || isSkip(text)) {
        temp.incomeMinRank = null;
      } else if (interactiveId === "MININC_1") {
        temp.incomeMinRank = 1;
      } else if (interactiveId === "MININC_2") {
        temp.incomeMinRank = 2;
      } else if (interactiveId === "MININC_3") {
        temp.incomeMinRank = 3;
      } else if (interactiveId === "MININC_4") {
        temp.incomeMinRank = 4;
      } else {
        await sendList(
          from,
          "💰 *Minimum income preference*",
          "Select",
          [
            { id: "MININC_1", title: "Up to ₹50,000" },
            { id: "MININC_2", title: "₹50K - ₹1L" },
            { id: "MININC_3", title: "₹1L - ₹3L" },
            { id: "MININC_4", title: "Above ₹3L" },
            { id: "MININC_SKIP", title: "No Preference" },
          ],
          "Income Range"
        );
        return;
      }

      const allVisible = await getAllVisibleProfiles();
      const userProfiles = await findProfilesByPhone(from);
      const userProfile = userProfiles[0] || {};
      
      const results = applyFiltersToVisibleProfiles(allVisible, {
        targetGender: oppositeGender(userProfile.gender),
        excludeProfileId: userProfile.profile_id,
        cityScope: temp.cityScope,
        userCity: userProfile.native_place,
        workCityScope: temp.workCityScope,
        userWorkCity: userProfile.work_city,
        ageMin: temp.ageMin,
        ageMax: temp.ageMax,
        maritalStatus: temp.maritalStatus,
        casteScope: temp.casteScope,
        userCaste: userProfile.caste,
        eduMinRank: temp.eduMinRank,
        incomeMinRank: temp.incomeMinRank,
      });

      if (!results.length) {
        await sendText(from, NO_MATCHES_MSG);
        await setState(from, "", {});
        await sendJoinSearchStopButtons(from);
        return;
      }

      temp.searchResults = results;
      temp.searchIndex = 0;
      await setState(from, "SEARCH_RESULTS_VIEW", temp);
      await showProfileCard(from, results[0], temp);
      return;
    }

    // ===================== DEFAULT / UNKNOWN =====================
    if (cmd === "START_AGAIN" || interactiveId === "START_AGAIN") {
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from);
      return;
    }

    if (cmd === "NEXT" && st.step === "SEARCH_RESULTS_VIEW") {
      if (!temp.searchResults || !temp.searchResults.length) {
        await sendText(from, "No search active.");
        return;
      }
      let newIndex = (temp.searchIndex || 0) + 1;
      if (newIndex >= temp.searchResults.length) newIndex = 0;
      temp.searchIndex = newIndex;
      await setState(from, "SEARCH_RESULTS_VIEW", temp);
      await showProfileCard(from, temp.searchResults[newIndex], temp);
      return;
    }

    if (!st.step) {
      await sendJoinSearchStopButtons(from);
      return;
    }

  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message || err);
  }
});

// Helper function for greetings
function isGreeting(text) {
  const greetings = ["HI", "HELLO", "HII", "HEY", "START", "MENU", "HOME", "VIVAHO", "NAMSTE", "नमस्ते", "नमस्कार"];
  return greetings.includes(cleanUpper(text));
}

// ===================== Start Server =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ${BRAND_NAME} Bot running on port ${PORT}`));
