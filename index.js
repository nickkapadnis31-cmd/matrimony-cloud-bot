// index.js — Vivaho WhatsApp Matrimony Bot (Final Polished Version)
// Brand: Vivaho | Tagline: "नवीन नाती – विश्वासाने जोडलेली."

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

function cleanLower(v) {
  return String(v || "").trim().toLowerCase();
}

function cleanUpper(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizeProfileId(v) {
  return String(v || "").trim().toUpperCase();
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

function isGreeting(text) {
  const greetings = ["HI", "HELLO", "HII", "HEY", "START", "MENU", "HOME", "VIVAHO", "NAMSTE", "नमस्ते", "नमस्कार"];
  return greetings.includes(cleanUpper(text));
}

function trimTo(str, max) {
  return String(str || "").slice(0, max);
}

// ===================== Rate Limiting =====================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const userMessageTimestamps = new Map();
const MIN_MESSAGE_GAP = 1500;
const MAX_MESSAGES_PER_MINUTE = 8;

async function checkRateLimit(phone) {
  const now = Date.now();
  const timestamps = userMessageTimestamps.get(phone) || [];
  const recentTimestamps = timestamps.filter(t => now - t < 60000);
 
  if (recentTimestamps.length >= MAX_MESSAGES_PER_MINUTE) {
    const oldestInWindow = recentTimestamps[0];
    const waitTime = 60000 - (now - oldestInWindow) + 1000;
    if (waitTime > 0 && waitTime < 30000) {
      console.log(`⏳ Rate limit wait ${waitTime}ms for ${phone}`);
      await delay(waitTime);
    }
  }
 
  if (recentTimestamps.length > 0) {
    const lastMessage = recentTimestamps[recentTimestamps.length - 1];
    const gap = now - lastMessage;
    if (gap < MIN_MESSAGE_GAP) {
      await delay(MIN_MESSAGE_GAP - gap);
    }
  }
 
  recentTimestamps.push(Date.now());
  userMessageTimestamps.set(phone, recentTimestamps.slice(-20));
}

const lastWebhookProcessed = new Map();
const WEBHOOK_DEBOUNCE_MS = 1500;

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const ADMIN_PHONE = normalizePhone(process.env.ADMIN_PHONE || "");
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || "";
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || "";
const UPI_ID = process.env.UPI_ID || "";
const QR_IMAGE_URL = process.env.VIVAHO_QR || process.env.QR_IMAGE_URL || "";

function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

// ===================== Branding =====================
const BRAND_NAME = "Vivaho";
const BRAND_TAGLINE = "नवीन नाती – विश्वासाने जोडलेली.";
const PROFILE_TAB = "profiles";
const STATE_TAB = "state";
const REQUESTS_TAB = "requests";
const MAX_PROFILES_PER_PHONE = 1;
const MIN_AGE = 18;

global.searchCache = new Map();

// ===================== Bilingual Messages =====================
const WELCOME_MSG = `✨ *${BRAND_NAME}* ✨\n${BRAND_TAGLINE}\n\n💍 *Welcome to your trusted Matrimony Service*\n*आपके विश्वसनीय मैट्रिमोनी सर्विस में आपका स्वागत है*\n\n📌 *Commands / कमांड्स:*\n• *JOIN* - Create profile | प्रोफाइल बनाएं\n• *SEARCH* - Find matches | रिश्ते खोजें\n• *STOP* - Cancel | रद्द करें\n\n👇 *Type JOIN, SEARCH, or STOP* 👇`;

const SEARCH_GENDER_MSG = `👰 *Select Bride* OR 🤵 *Select Groom*\n*वधू चुनें या वर चुनें* 👇`;

const SEARCHING_MSG = `🔍 *Searching for matches...* ⏳\n*मैच ढूंढे जा रहे हैं...*`;

const NO_MATCHES_MSG = `😔 *No matches found at this moment*\n*इस समय कोई मैच नहीं मिला*\n\n💫 *Try again later or create a profile to get discovered*\n*बाद में पुनः प्रयास करें या प्रोफाइल बनाएं*`;

// MODIFICATION 1: Income added to profile card
const PROFILE_CARD_TEMPLATE = (profile, age) => `📷 *Profile ${profile.profile_id}*\n\n🎂 Age / उम्र: ${age || "NA"}\n📏 Height / ऊंचाई: ${profile.height || "NA"}\n🕉️ Religion / धर्म: ${profile.religion || "NA"}\n👥 Caste / जात: ${profile.caste || "NA"}\n💍 Marital / वैवाहिक: ${profile.marital_status || "NA"}\n🎓 Education / शिक्षा: ${profile.education || "NA"}\n💼 Job / नौकरी: ${profile.job_title || profile.job || "NA"}\n💰 Income / आय: ${profile.income_annual || "NA"}\n🏠 Native / मूल स्थान: ${profile.native_place || "NA"}\n🏢 Work / कार्य स्थल: ${profile.work_city || "NA"}`;

const ACTION_BUTTONS_MSG = `👇 *Choose action* / *कोई कार्य चुनें* 👇`;

const PAYMENT_PLANS_MSG = `💰 *Premium Plans / प्रीमियम प्लान*\n\n💝 *₹300 - 3 Months*\n   ✓ Send Interest | रिश्ते भेजें\n\n💝 *₹1000 - 1 Year*\n   ✓ Send Interest | रिश्ते भेजें\n\n💎 *₹2000 - 1 Year (Premium)*\n   ✓ Send Interest + View Contact\n   ✓ रिश्ते भेजें + संपर्क देखें`;

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
        { folder: "vivaho_profiles", resource_type: "image" },
        (error, result) => {
          if (error) return resolve("");
          resolve(result?.secure_url || "");
        }
      );
      uploadStream.end(buffer);
    });
  } catch (err) {
    return "";
  }
}

// ===================== Google Sheets =====================
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

// ===================== WhatsApp API (with rate limiting) =====================
async function sendText(to, body) {
  const phone = normalizePhone(to);
  if (!phone) return;
  await checkRateLimit(phone);
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", to: phone, type: "text", text: { body: trimTo(body, 4096) } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
  } catch (err) {
    console.error("sendText failed:", err?.response?.data?.error?.code || err.message);
  }
}

async function sendImageByLink(to, imageLink, caption = "") {
  const phone = normalizePhone(to);
  if (!phone) return;
  await checkRateLimit(phone);
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", to: phone, type: "image", image: { link: imageLink, ...(caption ? { caption: trimTo(caption, 4096) } : {}) } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
  } catch (err) {
    console.error("sendImageByLink failed:", err?.response?.data?.error?.code || err.message);
  }
}

async function sendButtons(to, body, buttons) {
  const phone = normalizePhone(to);
  if (!phone || !buttons || buttons.length === 0 || buttons.length > 3) return;
  await checkRateLimit(phone);
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: trimTo(body, 1024) },
          action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
  } catch (err) {
    console.error("sendButtons failed:", err?.response?.data?.error?.code || err.message);
  }
}

async function sendList(to, body, buttonText, rows, sectionTitle = "Select") {
  const phone = normalizePhone(to);
  if (!phone || !rows || !rows.length) return;
  await checkRateLimit(phone);
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
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
            sections: [{ title: trimTo(sectionTitle, 24), rows: rows.map((r) => ({ id: String(r.id).slice(0, 256), title: String(r.title).slice(0, 24) })) }]
          }
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
  } catch (err) {
    console.error("sendList failed:", err?.response?.data?.error?.code || err.message);
  }
}

// MODIFICATION 4: Helper function to add STOP button
async function sendStopButton(to, body) {
  await sendButtons(to, body || "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
    { id: "STOP", title: "⏹️ STOP" },
  ]);
}

async function sendJoinSearchStopButtons(to) {
  await sendButtons(to, "👇 *Choose an option* / *एक विकल्प चुनें* 👇", [
    { id: "JOIN", title: "📝 JOIN" },
    { id: "SEARCH", title: "🔍 SEARCH" },
    { id: "STOP", title: "⏹️ STOP" },
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
  return { bytes: r.data, contentType: r.headers["content-type"] || "image/jpeg" };
}

// ===================== State Management =====================
async function getState(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${STATE_TAB}!A:D` });
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${STATE_TAB}!A:D` });
  const rows = res.data.values || [];
  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "") === phone) { rowIndex = i + 1; break; }
  }
  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${STATE_TAB}!A:D`, valueInputOption: "RAW", requestBody: { values: [[phone, step, temp_data, updatedAt]] } });
  } else {
    await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${STATE_TAB}!A${rowIndex}:D${rowIndex}`, valueInputOption: "RAW", requestBody: { values: [[phone, step, temp_data, updatedAt]] } });
  }
}

// ===================== Profiles =====================
async function getAllProfilesRows() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!A:X` });
  return res.data.values || [];
}

function profileRowToObj(row, rowIndex1Based) {
  return {
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
    approved_1: cleanUpper(row?.[18] || "PENDING"),
    approved_1_expiry: row?.[19] || "",
    approved_2: cleanUpper(row?.[20] || "PENDING"),
    approved_2_expiry: row?.[21] || "",
    created_at: row?.[22] || "",
    marital_status: row?.[23] || "",
  };
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
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!S${rowIndex1Based}:T${rowIndex1Based}`, valueInputOption: "RAW", requestBody: { values: [[status, expiryDate || ""]] } });
}

async function updateProfileApproval2(rowIndex1Based, status, expiryDate) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!U${rowIndex1Based}:V${rowIndex1Based}`, valueInputOption: "RAW", requestBody: { values: [[status, expiryDate || ""]] } });
}

async function deleteProfileRow(rowIndex1Based) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = meta.data.sheets.find((s) => s.properties?.title === PROFILE_TAB);
  const sheetId = sheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: "ROWS", startIndex: rowIndex1Based - 1, endIndex: rowIndex1Based } } }] }
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
    profile_id, phone, temp.name || "", temp.surname || "", temp.gender || "",
    temp.date_of_birth || "", temp.religion || "", temp.height || "", temp.caste || "",
    temp.native_place || "", temp.district || "", temp.work_city || "", temp.work_district || "",
    temp.education || "", temp.job || "", temp.job_title || "", temp.income_annual || "",
    temp.photo_url || "", "PENDING", "", "PENDING", "", createdAt, temp.marital_status || ""
  ];
  await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!A:X`, valueInputOption: "RAW", requestBody: { values: [row] } });
  return profile_id;
}

function getUserPaymentStatus(profile) {
  const canSendInterest = (profile.approved_1 === "APPROVED" && !isExpired(profile.approved_1_expiry)) ||
                          (profile.approved_2 === "APPROVED" && !isExpired(profile.approved_2_expiry));
  const canViewContact = (profile.approved_2 === "APPROVED" && !isExpired(profile.approved_2_expiry));
  return { canSendInterest, canViewContact };
}

// ===================== Requests =====================
async function appendRequest({ from_profile_id, to_profile_id, status, type, viewer_phone }) {
  const sheets = await getSheetsClient();
  const req_id = `REQ-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${REQUESTS_TAB}!A:G`, valueInputOption: "RAW", requestBody: { values: [[req_id, from_profile_id, to_profile_id, status, nowISO(), type, viewer_phone]] } });
}

async function findInterestRequest({ from_profile_id, to_profile_id }) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REQUESTS_TAB}!A:G` });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]?.[1] === from_profile_id && rows[i]?.[2] === to_profile_id && rows[i]?.[5] === "INTEREST") {
      return { rowIndex: i + 1, status: rows[i]?.[3] || "" };
    }
  }
  return null;
}

// ===================== Admin Notifications =====================
async function notifyAdminNewProfile(profileId, phone, temp) {
  if (!ADMIN_PHONE) return;
  await sendText(ADMIN_PHONE, `🆕 *New Registration*\n\n🆔 ID: ${profileId}\n📱 Phone: ${phone}\n👤 Name: ${temp.name || ""} ${temp.surname || ""}\n⚥ Gender: ${temp.gender || ""}\n📅 DOB: ${temp.date_of_birth || ""}`);
}

async function notifyAdminPayment(userPhone, profileId, planType) {
  if (!ADMIN_PHONE) return;
  let planMsg = "", buttons = [];
  if (planType === "PLAN_1_3MO") {
    planMsg = "₹300 for 3 months (Interest Only)";
    buttons = [{ id: `ADMIN_APPROVE_1_3MO_${profileId}_${userPhone}`, title: "APPROVE ₹300" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  } else if (planType === "PLAN_1_YEAR") {
    planMsg = "₹1000 for 1 year (Interest Only)";
    buttons = [{ id: `ADMIN_APPROVE_1_YEAR_${profileId}_${userPhone}`, title: "APPROVE ₹1000" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  } else if (planType === "PLAN_2_YEAR") {
    planMsg = "₹2000 for 1 year (Full Access)";
    buttons = [{ id: `ADMIN_APPROVE_2_YEAR_${profileId}_${userPhone}`, title: "APPROVE ₹2000" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  }
  await sendText(ADMIN_PHONE, `💰 *Payment Received*\n\n👤 User: ${userPhone}\n🆔 Profile: ${profileId}\n💳 Plan: ${planMsg}`);
  await sendButtons(ADMIN_PHONE, `📋 *Action for ${profileId}*`, buttons);
}

// ===================== Search Helpers =====================
async function getAllVisibleProfiles() {
  const rows = await getAllProfilesRows();
  const allProfiles = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
   
    const obj = {
      rowIndex: i + 1,
      profile_id: row[0] || "",
      phone: row[1] || "",
      name: row[2] || "",
      surname: row[3] || "",
      gender: (row[4] || "").toLowerCase(),
      date_of_birth: row[5] || "",
      religion: row[6] || "",
      height: row[7] || "",
      caste: row[8] || "",
      native_place: row[9] || "",
      district: row[10] || "",
      work_city: row[11] || "",
      work_district: row[12] || "",
      education: row[13] || "",
      job: row[14] || "",
      job_title: row[15] || "",
      income_annual: row[16] || "",
      photo_url: row[17] || "",
      approved_1: (row[18] || "PENDING").toUpperCase(),
      approved_1_expiry: row[19] || "",
      approved_2: (row[20] || "PENDING").toUpperCase(),
      approved_2_expiry: row[21] || "",
      created_at: row[22] || "",
      marital_status: row[23] || "",
    };
    if (obj.approved_1 !== "REJECTED" && obj.approved_2 !== "REJECTED") {
      allProfiles.push(obj);
    }
  }
  return allProfiles;
}

// MODIFICATION 2 & 3: Enhanced filter function
function applyFilters(profiles, filters) {
  let results = [...profiles];
 
  if (filters.gender) {
    results = results.filter(p => p.gender === filters.gender);
  }
 
  if (filters.religion && filters.religion !== "ANY") {
    results = results.filter(p => cleanLower(p.religion) === cleanLower(filters.religion));
  }
 
  if (filters.caste && filters.caste !== "ANY") {
    results = results.filter(p => cleanLower(p.caste).includes(cleanLower(filters.caste)));
  }
 
  if (filters.workCity && filters.workCity !== "ANY") {
    results = results.filter(p => cleanLower(p.work_city).includes(cleanLower(filters.workCity)));
  }
 
  // Income filter
  if (filters.income && filters.income !== "ANY") {
    results = results.filter(p => {
      const inc = cleanLower(p.income_annual || "");
      switch(filters.income) {
        case "0-50k": return inc.includes("up to 50") || inc.includes("upto 50");
        case "50k-1l": return inc.includes("50,000 to 1,00,000") || (inc.includes("50") && inc.includes("1l"));
        case "1l-3l": return inc.includes("1,00,000 to 3,00,000") || inc.includes("1l - 3l") || inc.includes("1l-3l");
        case "above-3l": return inc.includes("above 3") || inc.includes("3,00,000");
        default: return true;
      }
    });
  }
 
  // Age filter
  if (filters.ageRange && filters.ageRange !== "ANY") {
    results = results.filter(p => {
      const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
      if (age === null) return false;
      switch(filters.ageRange) {
        case "below-25": return age < 25;
        case "25-28": return age >= 25 && age <= 28;
        case "28-32": return age >= 28 && age <= 32;
        case "above-32": return age > 32;
        default: return true;
      }
    });
  }
 
  // Marital status filter
  if (filters.marital_status && filters.marital_status !== "ANY") {
    results = results.filter(p => cleanLower(p.marital_status) === cleanLower(filters.marital_status));
  }
 
  return results;
}

async function showProfileCard(to, profile, temp) {
  const age = calcAgeFromDobDDMMYYYY(profile.date_of_birth);
  const msg = PROFILE_CARD_TEMPLATE(profile, age);
 
  if (profile.photo_url) {
    await sendImageByLink(to, profile.photo_url, msg);
  } else {
    await sendText(to, msg);
  }
 
  await delay(500);
 
  temp.currentViewingProfile = profile;
  await setState(to, "SEARCH_RESULTS_VIEW", temp);
 
  // MODIFICATION 2: 3 buttons with FILTER SEARCH + STOP
  await sendButtons(to, ACTION_BUTTONS_MSG, [
    { id: "SELECT_ACTION", title: "🎯 SELECT" },
    { id: "FILTER_SEARCH", title: "🔧 FILTER" },
    { id: "NEXT", title: "⏩ NEXT" },
  ]);
}

async function sendNotRegisteredMessage(to) {
  await sendText(to, `❌ *Registration Required*\n*पंजीकरण आवश्यक है*\n\n📝 Please JOIN and create your profile to access this feature.\nकृपया इस सुविधा का उपयोग करने के लिए JOIN करें और अपनी प्रोफाइल बनाएं।`);
  await sendButtons(to, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
    { id: "JOIN", title: "📝 JOIN" },
    { id: "SEARCH", title: "🔍 SEARCH" },
    { id: "STOP", title: "⏹️ STOP" },
  ]);
}

// ===================== handleDirectCommand =====================
async function handleDirectCommand(from, cmd, args, temp, st) {
  if (cmd === "MYPROFILES") {
    const profiles = await findProfilesByPhone(from);
    if (!profiles.length) {
      await sendText(from, "📝 *You don't have any profiles yet.*\n*आपकी अभी तक कोई प्रोफाइल नहीं है।*\n\nUse JOIN to create one!\nJOIN करके प्रोफाइल बनाएं!");
      await sendJoinSearchStopButtons(from);
      return;
    }
    let msg = "📋 *Your Profiles / आपकी प्रोफाइल्स*\n\n";
    for (const p of profiles) {
      const status = p.approved_1 === "APPROVED" ? "✅ ACTIVE" : "⏳ PENDING";
      msg += `• ${p.profile_id} - ${status}\n`;
    }
    await sendText(from, msg);
    await sendButtons(from, "Select profile / प्रोफाइल चुनें:", profiles.slice(0, 3).map(p => ({ id: `MYPROFILE_${p.profile_id}`, title: p.profile_id })));
    return;
  }

  if (cmd === "DELETE") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "❌ *Usage / उपयोग:* DELETE MH-XXXX"); return; }
    const prof = await findProfileById(profileId);
    if (!prof) { await sendText(from, "❌ *Profile not found*\n*प्रोफाइल नहीं मिली*"); return; }
    if (prof.phone !== from) { await sendText(from, "❌ *You can only delete your own profile*\n*आप सिर्फ अपनी प्रोफाइल delete कर सकते हैं*"); return; }
    await deleteProfileRow(prof.rowIndex);
    await setState(from, "", {});
    await sendText(from, `✅ *Profile ${profileId} deleted successfully*\n*प्रोफाइल ${profileId} सफलतापूर्वक हटा दी गई*`);
    await sendJoinSearchStopButtons(from);
    return;
  }

  if (cmd === "SEARCH") {
    await sendText(from, SEARCH_GENDER_MSG);
    await setState(from, "SEARCH_BRIDE_GROOM", {});
    await sendButtons(from, "👇 *Select* / *चुनें* 👇", [
      { id: "SEARCH_BRIDE", title: "👰 BRIDE" },
      { id: "SEARCH_GROOM", title: "🤵 GROOM" },
      { id: "STOP", title: "⏹️ STOP" },
    ]);
    return;
  }

  if (cmd === "NEXT") {
    const cacheId = temp.searchCacheId;
    const cache = global.searchCache?.get(cacheId);
   
    if (!cache || !cache.results || !cache.results.length) {
      await sendText(from, "❌ *No active search*\n*कोई सक्रिय खोज नहीं*\n\nType SEARCH to start\nSEARCH टाइप करें।");
      await sendJoinSearchStopButtons(from);
      return;
    }
   
    let newIndex = cache.index + 1;
    if (newIndex >= cache.results.length) newIndex = 0;
    cache.index = newIndex;
    global.searchCache.set(cacheId, cache);
   
    temp.searchCacheId = cacheId;
    await setState(from, "SEARCH_RESULTS_VIEW", temp);
   
    const profile = cache.results[newIndex];
    await showProfileCard(from, profile, temp);
    return;
  }

  if (cmd === "DETAILS") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "❌ *Usage / उपयोग:* DETAILS MH-XXXX"); return; }
    const target = await findProfileById(profileId);
    if (!target) { await sendText(from, "❌ *Profile not found*\n*प्रोफाइल नहीं मिली*"); return; }
    const age = calcAgeFromDobDDMMYYYY(target.date_of_birth);
    const msg = `📄 *Profile Details / प्रोफाइल जानकारी*\n\n🆔 ID: ${target.profile_id}\n⚥ Gender / लिंग: ${target.gender}\n💍 Marital Status / वैवाहिक स्थिति: ${target.marital_status || "NA"}\n🎂 Age / उम्र: ${age || "NA"}\n\n🏠 Native / मूल स्थान: ${target.native_place || "NA"}, ${target.district || "NA"}\n🏢 Work / कार्य स्थल: ${target.work_city || "NA"}, ${target.work_district || "NA"}\n\n🕉️ Religion / धर्म: ${target.religion || "NA"}\n👥 Caste / जात: ${target.caste || "NA"}\n📏 Height / ऊंचाई: ${target.height || "NA"}\n\n🎓 Education / शिक्षा: ${target.education || "NA"}\n💼 Job Type / नौकरी प्रकार: ${target.job || "NA"}\n📌 Job Title / पद: ${target.job_title || "NA"}\n💰 Income / आय: ${target.income_annual || "NA"}`;
   
    if (target.photo_url) {
      await sendImageByLink(from, target.photo_url, msg);
    } else {
      await sendText(from, msg);
    }
    // MODIFICATION 4: Add buttons after DETAILS
    await sendJoinSearchStopButtons(from);
    return;
  }

  if (cmd === "INTEREST") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "❌ *Usage / उपयोग:* INTEREST MH-XXXX"); return; }
   
    const userProfiles = await findProfilesByPhone(from);
    if (!userProfiles.length) {
      await sendText(from, `❌ *Registration Required*\n*पंजीकरण आवश्यक है*\n\n📝 Please JOIN to send interest to profiles.\nकृपया रिश्ते भेजने के लिए JOIN करें।\n\n${PAYMENT_PLANS_MSG}`);
      await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
        { id: "JOIN", title: "📝 JOIN" },
        { id: "SEARCH", title: "🔍 SEARCH" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }
   
    const userProfile = userProfiles[0];
    const { canSendInterest } = getUserPaymentStatus(userProfile);
   
    if (!canSendInterest) {
      await sendText(from, `💰 *Premium Feature*\n*प्रीमियम सुविधा*\n\n⚠️ You need an active plan to send interest.\nरिश्ते भेजने के लिए सक्रिय प्लान आवश्यक है।\n\n${PAYMENT_PLANS_MSG}`);
      await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
        { id: "MAKE_PAYMENT", title: "💳 MAKE PAYMENT" },
        { id: "SEARCH", title: "🔍 SEARCH" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }
   
    if (userProfile.profile_id === profileId) { await sendText(from, "❌ *Cannot send interest to yourself*\n*अपने आप को interest नहीं भेज सकते*"); return; }
   
    const target = await findProfileById(profileId);
    if (!target) { await sendText(from, "❌ *Profile not found*\n*प्रोफाइल नहीं मिली*"); return; }
   
    const existing = await findInterestRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id });
    if (existing && existing.status === "SENT") { await sendText(from, "ℹ️ *Interest already sent*\n*Interest पहले ही भेजा जा चुका है*"); return; }
   
    await appendRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id, status: "SENT", type: "INTEREST", viewer_phone: from });
    await sendButtons(target.phone, `💌 *New Interest!*\n*नया रिश्ता!*\n\nSomeone is interested in your profile!\nकिसी ने आपकी प्रोफाइल में रुचि दिखाई है!\n\nFrom / से: ${userProfile.profile_id}`, [
      { id: `ACCEPT_${userProfile.profile_id}`, title: "✅ ACCEPT" },
      { id: `REJECT_${userProfile.profile_id}`, title: "❌ REJECT" },
    ]);
    await sendText(from, `✅ *Interest sent successfully!*\n*रिश्ता सफलतापूर्वक भेजा गया!*\n\nTo / को: ${profileId}\n\n💫 You'll be notified if they respond.\nउनके जवाब देने पर आपको सूचित किया जाएगा।`);
    // MODIFICATION 4: Add buttons after interest sent
    await sendJoinSearchStopButtons(from);
    return;
  }

  if (cmd === "ACCEPT" || cmd === "REJECT") {
    const interestedProfileId = normalizeProfileId(args[0]);
    if (!interestedProfileId) { await sendText(from, "❌ *Usage / उपयोग:* ACCEPT MH-XXXX or REJECT MH-XXXX"); return; }
   
    const receiverProfiles = await findProfilesByPhone(from);
    if (!receiverProfiles.length) { await sendText(from, "❌ *No profile found*\n*कोई प्रोफाइल नहीं मिली*\n\nPlease JOIN first.\nकृपया पहले JOIN करें।"); return; }
   
    const receiverActive = receiverProfiles[0];
    const existing = await findInterestRequest({ from_profile_id: interestedProfileId, to_profile_id: receiverActive.profile_id });
    if (!existing || existing.status !== "SENT") { await sendText(from, "ℹ️ *No pending interest found*\n*कोई लंबित रिश्ता नहीं मिला*"); return; }
   
    const senderProfile = await findProfileById(interestedProfileId);
   
    if (cmd === "REJECT") {
      await sendText(from, `❌ *Interest rejected*\n*रिश्ता अस्वीकृत*\n\nFrom: ${interestedProfileId}`);
      if (senderProfile) await sendText(senderProfile.phone, `❌ *Interest Declined*\n*रिश्ता अस्वीकृत*\n\nYour interest was not accepted by ${receiverActive.profile_id}\nआपका रिश्ता ${receiverActive.profile_id} द्वारा स्वीकार नहीं किया गया।\n\n💫 Keep searching! More matches await!\nखोजते रहें! और भी मैच आपका इंतजार कर रहे हैं!`);
      // MODIFICATION 4: Add buttons
      await sendJoinSearchStopButtons(from);
      return;
    }
   
    await sendText(from, `✅ *Interest Accepted!*\n*रिश्ता स्वीकृत!*\n\nFrom: ${interestedProfileId}\n\n💫 Connecting you both...\nआप दोनों को जोड़ा जा रहा है...`);
   
    const { canViewContact } = getUserPaymentStatus(receiverActive);
   
    if (canViewContact && senderProfile) {
      await sendText(from, `📞 *Contact Shared / संपर्क साझा*\n\n👤 Profile: ${interestedProfileId}\n📱 Phone: ${senderProfile.phone}\n👤 Name: ${senderProfile.name || "NA"} ${senderProfile.surname || "NA"}`);
      await sendText(senderProfile.phone, `🎉 *Great News!*\n*शानदार खबर!* 🎉\n\n✅ Your interest was accepted by ${receiverActive.profile_id}!\nआपका रिश्ता ${receiverActive.profile_id} ने स्वीकार कर लिया!\n\n📞 *Contact Shared / संपर्क साझा:*\n👤 Profile: ${receiverActive.profile_id}\n📱 Phone: ${receiverActive.phone}\n👤 Name: ${receiverActive.name || "NA"} ${receiverActive.surname || "NA"}\n\n💝 *Best wishes from Vivaho!*\n*Vivaho की ओर से शुभकामनाएं!* 💝`);
    } else {
      await sendText(senderProfile.phone, `🎉 *Great News!*\n*शानदार खबर!* 🎉\n\n✅ Your interest was accepted by ${receiverActive.profile_id}!\nआपका रिश्ता ${receiverActive.profile_id} ने स्वीकार कर लिया!\n\n📞 They will contact you soon.\nवे जल्द ही आपसे संपर्क करेंगे।\n\n💝 *Best wishes from Vivaho!*\n*Vivaho की ओर से शुभकामनाएं!* 💝`);
    }
    // MODIFICATION 4: Add buttons
    await sendJoinSearchStopButtons(from);
    return;
  }
}

// ===================== Health & Webhook =====================
app.get("/health", (req, res) => res.status(200).send("OK"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
 
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;
   
    const from = normalizePhone(msg.from);
   
    const now = Date.now();
    const lastProcessed = lastWebhookProcessed.get(from) || 0;
    if (now - lastProcessed < WEBHOOK_DEBOUNCE_MS) {
      console.log(`⏩ Debounced message from ${from}`);
      return;
    }
    lastWebhookProcessed.set(from, now);
   
    if (Math.random() < 0.05) {
      for (const [key, timestamp] of lastWebhookProcessed.entries()) {
        if (now - timestamp > 60000) lastWebhookProcessed.delete(key);
      }
    }
   
    const msgType = msg.type;
    const text = (msg.text?.body || "").trim();
    const interactiveId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";
    const st = await getState(from);
    const temp = safeJsonParse(st.temp_data || "{}", {});
    let effectiveInput = text || interactiveId || "";

    if (Math.random() < 0.01) {
      for (const [key, val] of global.searchCache.entries()) {
        if (Date.now() - val.timestamp > 60 * 60 * 1000) {
          global.searchCache.delete(key);
        }
      }
    }

    const isButtonClick = !!interactiveId;
   
    if (interactiveId.startsWith("ACCEPT_")) effectiveInput = `ACCEPT ${interactiveId.replace("ACCEPT_", "")}`;
    else if (interactiveId.startsWith("REJECT_")) effectiveInput = `REJECT ${interactiveId.replace("REJECT_", "")}`;
    else if (interactiveId === "SELECT_ACTION") effectiveInput = "SELECT_ACTION";
    else if (interactiveId === "SEARCH_BRIDE" || interactiveId === "SEARCH_GROOM") effectiveInput = interactiveId;
    else if (interactiveId === "MAKE_PAYMENT") effectiveInput = "MAKE_PAYMENT";
    else if (interactiveId === "SEND_INTEREST") effectiveInput = "SEND_INTEREST";
    else if (interactiveId === "VIEW_CONTACT") effectiveInput = "VIEW_CONTACT";
    else if (interactiveId === "NEXT") effectiveInput = "NEXT";
    else if (interactiveId === "FILTER_SEARCH") effectiveInput = "FILTER_SEARCH";
    else if (interactiveId === "CLEAR_FILTERS") effectiveInput = "CLEAR_FILTERS";
    else if (interactiveId === "SKIP_FILTER") effectiveInput = "SKIP_FILTER";
    else if (interactiveId.startsWith("ADMIN_APPROVE_1_3MO_")) {
      const parts = interactiveId.replace("ADMIN_APPROVE_1_3MO_", "").split("_");
      effectiveInput = `ADMIN_APPROVE_1_3MO ${parts[0]} ${parts[1]}`;
    } else if (interactiveId.startsWith("ADMIN_APPROVE_1_YEAR_")) {
      const parts = interactiveId.replace("ADMIN_APPROVE_1_YEAR_", "").split("_");
      effectiveInput = `ADMIN_APPROVE_1_YEAR ${parts[0]} ${parts[1]}`;
    } else if (interactiveId.startsWith("ADMIN_APPROVE_2_YEAR_")) {
      const parts = interactiveId.replace("ADMIN_APPROVE_2_YEAR_", "").split("_");
      effectiveInput = `ADMIN_APPROVE_2_YEAR ${parts[0]} ${parts[1]}`;
    } else if (interactiveId.startsWith("ADMIN_REJECT_")) {
      const parts = interactiveId.replace("ADMIN_REJECT_", "").split("_");
      effectiveInput = `ADMIN_REJECT ${parts[0]} ${parts[1]}`;
    } else if (interactiveId.startsWith("MYPROFILE_")) {
      const profileId = interactiveId.replace("MYPROFILE_", "");
      const prof = await findProfileById(profileId);
      if (prof) {
        await sendButtons(from, `📌 *Profile / प्रोफाइल: ${profileId}*`, [
          { id: `DETAILS_${profileId}`, title: "📄 DETAILS" },
          { id: `SELF_DELETE_${profileId}`, title: "🗑️ DELETE" },
        ]);
      }
      return;
    } else if (interactiveId.startsWith("DETAILS_")) {
      effectiveInput = `DETAILS ${interactiveId.replace("DETAILS_", "")}`;
    } else if (interactiveId.startsWith("SELF_DELETE_")) {
      effectiveInput = `DELETE ${interactiveId.replace("SELF_DELETE_", "")}`;
    }

    const { cmd, args } = parseCommand(effectiveInput);

    // ===================== MAIN MENU HANDLER =====================
    const isGreetingText = isGreeting(Text) && !isButtonClick;
   
    if (isGreetingText) {
  await setState(from, "", {});
  await sendText(from, "✅ *Process stopped*\n*प्रक्रिया बंद*\n\nAll your data is saved.\nआपका सारा डेटा सुरक्षित है।");
  await sendJoinSearchStopButtons(from);
  return;
}
   
    if (!st.step && !interactiveId && text && !["JOIN","SEARCH","STOP","NEXT","MYPROFILES","DELETE","DETAILS","INTEREST","ACCEPT","REJECT"].includes(cmd)) {
      await sendText(from, "ℹ️ *Please use the buttons below*\n*कृपया नीचे दिए गए बटन का उपयोग करें*");
      await delay(500);
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== JOIN =====================
    if (cmd === "JOIN") {
      const existing = await findProfilesByPhone(from);
      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        const profile = existing[0];
        const status = profile.approved_1 === "APPROVED" ? "✅ ACTIVE" : "⏳ PENDING";
        await sendText(from, `ℹ️ *You already have a profile!*\n*आपके पास पहले से प्रोफाइल है!*\n\n🆔 ID: ${profile.profile_id}\n📊 Status: ${status}\n\n📝 You can manage your profile or search for matches.\nआप अपनी प्रोफाइल प्रबंधित कर सकते हैं या रिश्ते खोज सकते हैं।`);
        await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
          { id: "MYPROFILES", title: "📋 MY PROFILES" },
          { id: "SEARCH", title: "🔍 SEARCH" },
          { id: "STOP", title: "⏹️ STOP" },
        ]);
        return;
      }
      await setState(from, "ASK_NAME", {});
      await sendText(from, "📝 *Let's create your profile!*\n*आइए आपकी प्रोफाइल बनाएं!*\n\nFirst, enter your name / पहले अपना नाम लिखें:");
      return;
    }

    if (cmd === "SEARCH") {
      await handleDirectCommand(from, "SEARCH", [], temp, st);
      return;
    }

    if (cmd === "STOP") {
      await setState(from, "", {});
      await sendText(from, "✅ *Process stopped*\n*प्रक्रिया बंद*\n\nAll your data is saved.\nआपका सारा डेटा सुरक्षित है।");
      await sendJoinSearchStopButtons(from);
      return;
    }

    if (cmd === "NEXT") { await handleDirectCommand(from, "NEXT", [], temp, st); return; }
    if (cmd === "MYPROFILES") { await handleDirectCommand(from, "MYPROFILES", [], temp, st); return; }
    if (cmd === "DELETE") { await handleDirectCommand(from, "DELETE", args, temp, st); return; }
    if (cmd === "DETAILS") { await handleDirectCommand(from, "DETAILS", args, temp, st); return; }
    if (cmd === "INTEREST") { await handleDirectCommand(from, "INTEREST", args, temp, st); return; }
    if (cmd === "ACCEPT" || cmd === "REJECT") { await handleDirectCommand(from, cmd, args, temp, st); return; }

    // ===================== SEARCH BRIDE/GROOM =====================
    if (effectiveInput === "SEARCH_BRIDE" || effectiveInput === "SEARCH_GROOM") {
      await sendText(from, SEARCHING_MSG);
     
      try {
        const targetGender = effectiveInput === "SEARCH_BRIDE" ? "female" : "male";
        const allVisible = await getAllVisibleProfiles();
       
        if (allVisible.length === 0) {
          await sendText(from, "❌ *No profiles in database*\n*डेटाबेस में कोई प्रोफाइल नहीं*\n\nBe the first to JOIN!\nसबसे पहले JOIN करें!");
          await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
            { id: "JOIN", title: "📝 JOIN" },
            { id: "SEARCH", title: "🔄 RETRY" },
            { id: "STOP", title: "⏹️ STOP" },
          ]);
          await setState(from, "", {});
          return;
        }
       
        let results = allVisible.filter(p => p.gender === targetGender);
       
        const activeFilters = temp.filters || {};
        if (Object.keys(activeFilters).length > 0) {
          results = applyFilters(results, activeFilters);
        }
       
        if (results.length === 0) {
          await sendText(from, NO_MATCHES_MSG);
          await sendButtons(from, "👇 *What would you like to do?*\n*आप क्या करना चाहेंगे?*", [
            { id: "FILTER_SEARCH", title: "🔧 FILTER" },
            { id: "SEARCH", title: "🔄 NEW SEARCH" },
            { id: "STOP", title: "⏹️ STOP" },
          ]);
          await setState(from, "", {});
          return;
        }
       
        results.sort(() => Math.random() - 0.5);
       
        const cacheId = `${from}_${Date.now()}`;
        global.searchCache.set(cacheId, { results, index: 0, timestamp: Date.now(), gender: targetGender });
       
        temp.searchCacheId = cacheId;
        await setState(from, "SEARCH_RESULTS_VIEW", temp);
       
        await showProfileCard(from, results[0], temp);
       
      } catch (err) {
        console.error("Search error:", err);
        await sendText(from, "❌ *Something went wrong*\n*कुछ गड़बड़ हुई*\n\nPlease try again.\nकृपया पुनः प्रयास करें।");
        await setState(from, "", {});
        await sendJoinSearchStopButtons(from);
      }
      return;
    }

    // ===================== SELECT ACTION =====================
    if (effectiveInput === "SELECT_ACTION") {
      if (!temp.currentViewingProfile) {
        await sendText(from, "ℹ️ *No profile selected*\n*कोई प्रोफाइल चुनी नहीं गई*\n\nStarting new search...");
        await sendText(from, SEARCH_GENDER_MSG);
        await setState(from, "SEARCH_BRIDE_GROOM", {});
        await sendButtons(from, "👇 *Select* / *चुनें* 👇", [
          { id: "SEARCH_BRIDE", title: "👰 BRIDE" },
          { id: "SEARCH_GROOM", title: "🤵 GROOM" },
          { id: "STOP", title: "⏹️ STOP" },
        ]);
        return;
      }
     
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendButtons(from, `💖 *Actions for ${temp.currentViewingProfile.profile_id}*`, [
          { id: "SEND_INTEREST", title: "💌 SEND INTEREST" },
          { id: "VIEW_CONTACT", title: "📞 VIEW CONTACT" },
          { id: "NEXT", title: "⏩ NEXT" },
        ]);
        return;
      }
     
      const { canSendInterest, canViewContact } = getUserPaymentStatus(userProfiles[0]);
     
      const buttons = [];
      if (canSendInterest) buttons.push({ id: "SEND_INTEREST", title: "💌 SEND INTEREST" });
      if (canViewContact) buttons.push({ id: "VIEW_CONTACT", title: "📞 VIEW CONTACT" });
      buttons.push({ id: "NEXT", title: "⏩ NEXT" });
     
      if (!canSendInterest && !canViewContact) {
        await sendText(from, `💰 *Activate Premium*\n*प्रीमियम सक्रिय करें*\n\n${PAYMENT_PLANS_MSG}`);
        await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
          { id: "MAKE_PAYMENT", title: "💳 MAKE PAYMENT" },
          { id: "NEXT", title: "⏩ NEXT" },
          { id: "STOP", title: "⏹️ STOP" },
        ]);
        return;
      }
     
      await sendButtons(from, `💖 *Actions for ${temp.currentViewingProfile.profile_id}*`, buttons);
      return;
    }

    if (effectiveInput === "SEND_INTEREST") {
      if (!temp.currentViewingProfile) return;
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendNotRegisteredMessage(from);
        return;
      }
      await handleDirectCommand(from, "INTEREST", [temp.currentViewingProfile.profile_id], temp, st);
      return;
    }

    if (effectiveInput === "VIEW_CONTACT") {
      if (!temp.currentViewingProfile) return;
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendNotRegisteredMessage(from);
        return;
      }
      const { canViewContact } = getUserPaymentStatus(userProfiles[0]);
      if (!canViewContact) {
        await sendText(from, `🔒 *Premium Feature*\n*प्रीमियम सुविधा*\n\n📱 View Contact requires ₹2000 plan.\nसंपर्क देखने के लिए ₹2000 प्लान आवश्यक है।`);
        await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
          { id: "MAKE_PAYMENT", title: "💳 UPGRADE" },
          { id: "NEXT", title: "⏩ NEXT" },
          { id: "STOP", title: "⏹️ STOP" },
        ]);
        return;
      }
      const target = temp.currentViewingProfile;
      await sendText(from, `📞 *Contact Details / संपर्क विवरण*\n\n👤 Name: ${target.name || "NA"} ${target.surname || "NA"}\n🆔 Profile: ${target.profile_id}\n📱 Phone: ${target.phone}\n\n💝 *Best wishes from Vivaho!*\n*Vivaho की ओर से शुभकामनाएं!*`);
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== MODIFICATION 2 & 3: FILTER SEARCH FLOW =====================
    if (effectiveInput === "FILTER_SEARCH") {
      await setState(from, "FILTER_GENDER", temp);
      await sendText(from, "🔧 *Filter Search*\n*फ़िल्टर खोज*\n\nFirst, select gender:");
      await sendButtons(from, "👇 *Select Gender* / *लिंग चुनें* 👇", [
        { id: "FILTER_BRIDE", title: "👰 BRIDE" },
        { id: "FILTER_GROOM", title: "🤵 GROOM" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }

    // Filter Step 1: Gender
    if (st.step === "FILTER_GENDER") {
      if (effectiveInput === "FILTER_BRIDE" || effectiveInput === "FILTER_GROOM") {
        temp.filters = temp.filters || {};
        temp.filters.gender = effectiveInput === "FILTER_BRIDE" ? "female" : "male";
        await setState(from, "FILTER_RELIGION", temp);
        await sendText(from, "🕉️ *Religion / धर्म*\n\nType religion name or tap ANY\nधर्म का नाम लिखें या ANY tap करें");
        await sendButtons(from, "👇 *Choose* / *चुनें* 👇", [
          { id: "SKIP_FILTER", title: "ANY" },
          { id: "STOP", title: "⏹️ STOP" },
        ]);
        return;
      }
    }

    // Filter Step 2: Religion
    if (st.step === "FILTER_RELIGION") {
      if (effectiveInput === "SKIP_FILTER") {
        temp.filters = temp.filters || {};
        temp.filters.religion = "ANY";
      } else if (text && text.length >= 2) {
        temp.filters = temp.filters || {};
        temp.filters.religion = text;
      } else {
        await sendText(from, "❌ Please type religion or tap ANY.\nकृपया धर्म लिखें या ANY tap करें।");
        return;
      }
      await setState(from, "FILTER_CASTE", temp);
      await sendText(from, "👥 *Caste / जाति*\n\nType caste name or tap ANY\nजाति का नाम लिखें या ANY tap करें");
      await sendButtons(from, "👇 *Choose* / *चुनें* 👇", [
        { id: "SKIP_FILTER", title: "ANY" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }

    // Filter Step 3: Caste
    if (st.step === "FILTER_CASTE") {
      if (effectiveInput === "SKIP_FILTER") {
        temp.filters = temp.filters || {};
        temp.filters.caste = "ANY";
      } else if (text && text.length >= 2) {
        temp.filters = temp.filters || {};
        temp.filters.caste = text;
      } else {
        await sendText(from, "❌ Please type caste or tap ANY.\nकृपया जाति लिखें या ANY tap करें।");
        return;
      }
      await setState(from, "FILTER_WORK_CITY", temp);
      await sendText(from, "🏢 *Work City / कार्य शहर*\n\nType city name or tap ANY\nशहर का नाम लिखें या ANY tap करें");
      await sendButtons(from, "👇 *Choose* / *चुनें* 👇", [
        { id: "SKIP_FILTER", title: "ANY" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }

    // Filter Step 4: Work City
    if (st.step === "FILTER_WORK_CITY") {
      if (effectiveInput === "SKIP_FILTER") {
        temp.filters = temp.filters || {};
        temp.filters.workCity = "ANY";
      } else if (text && text.length >= 2) {
        temp.filters = temp.filters || {};
        temp.filters.workCity = text;
      } else {
        await sendText(from, "❌ Please type city or tap ANY.\nकृपया शहर लिखें या ANY tap करें।");
        return;
      }
      await setState(from, "FILTER_INCOME", temp);
      await sendList(from, "💰 *Income / आय*\n\nSelect income range", "Select", [
        { id: "INC_0_50K", title: "₹0 - 50,000" },
        { id: "INC_50K_1L", title: "₹50K - 1 Lakh" },
        { id: "INC_1L_3L", title: "₹1L - 3 Lakh" },
        { id: "INC_ABOVE_3L", title: "Above ₹3 Lakh" },
        { id: "INC_ANY", title: "Any" },
      ], "Income Range");
      return;
    }

    // Filter Step 5: Income
    if (st.step === "FILTER_INCOME") {
      let income = "";
      if (interactiveId === "INC_0_50K") income = "0-50k";
      else if (interactiveId === "INC_50K_1L") income = "50k-1l";
      else if (interactiveId === "INC_1L_3L") income = "1l-3l";
      else if (interactiveId === "INC_ABOVE_3L") income = "above-3l";
      else if (interactiveId === "INC_ANY") income = "ANY";
      if (!income) { await sendText(from, "❌ Please select income range.\nकृपया आय सीमा चुनें।"); return; }
      temp.filters = temp.filters || {};
      temp.filters.income = income;
      await setState(from, "FILTER_AGE", temp);
      await sendList(from, "🎂 *Age / उम्र*\n\nSelect age range", "Select", [
        { id: "AGE_BELOW_25", title: "Below 25" },
        { id: "AGE_25_28", title: "25 to 28" },
        { id: "AGE_28_32", title: "28 to 32" },
        { id: "AGE_ABOVE_32", title: "Above 32" },
        { id: "AGE_ANY", title: "Any" },
      ], "Age Range");
      return;
    }

    // Filter Step 6: Age
    if (st.step === "FILTER_AGE") {
      let ageRange = "";
      if (interactiveId === "AGE_BELOW_25") ageRange = "below-25";
      else if (interactiveId === "AGE_25_28") ageRange = "25-28";
      else if (interactiveId === "AGE_28_32") ageRange = "28-32";
      else if (interactiveId === "AGE_ABOVE_32") ageRange = "above-32";
      else if (interactiveId === "AGE_ANY") ageRange = "ANY";
      if (!ageRange) { await sendText(from, "❌ Please select age range.\nकृपया आयु सीमा चुनें।"); return; }
      temp.filters = temp.filters || {};
      temp.filters.ageRange = ageRange;
      await setState(from, "FILTER_MARITAL", temp);
      await sendList(from, "💍 *Marital Status / वैवाहिक स्थिति*", "Select", [
        { id: "MS_UNMARRIED", title: "Unmarried / अविवाहित" },
        { id: "MS_DIVORCED", title: "Divorced / तलाकशुदा" },
        { id: "MS_WIDOWED", title: "Widowed / विधुर/विधवा" },
        { id: "MS_ANY", title: "Any / कोई भी" },
      ], "Marital Status");
      return;
    }

    // Filter Step 7: Marital Status + Execute Search
    if (st.step === "FILTER_MARITAL") {
      let ms = "";
      if (interactiveId === "MS_UNMARRIED") ms = "Unmarried";
      else if (interactiveId === "MS_DIVORCED") ms = "Divorced";
      else if (interactiveId === "MS_WIDOWED") ms = "Widowed";
      else if (interactiveId === "MS_ANY") ms = "ANY";
      if (!ms) { await sendText(from, "❌ Please select marital status.\nकृपया वैवाहिक स्थिति चुनें।"); return; }
      temp.filters = temp.filters || {};
      temp.filters.marital_status = ms;
     
      // Execute filtered search
      await sendText(from, SEARCHING_MSG);
     
      try {
        const allVisible = await getAllVisibleProfiles();
       
        if (allVisible.length === 0) {
          await sendText(from, "❌ *No profiles in database*\n*डेटाबेस में कोई प्रोफाइल नहीं*");
          await sendJoinSearchStopButtons(from);
          await setState(from, "", {});
          return;
        }
       
        let results = applyFilters(allVisible, temp.filters || {});
       
        if (results.length === 0) {
          await sendText(from, NO_MATCHES_MSG);
          await sendButtons(from, "👇 *What would you like to do?*\n*आप क्या करना चाहेंगे?*", [
            { id: "FILTER_SEARCH", title: "🔧 NEW FILTER" },
            { id: "SEARCH", title: "🔄 ALL PROFILES" },
            { id: "STOP", title: "⏹️ STOP" },
          ]);
          await setState(from, "", {});
          return;
        }
       
        results.sort(() => Math.random() - 0.5);
       
        const cacheId = `${from}_${Date.now()}`;
        global.searchCache.set(cacheId, { results, index: 0, timestamp: Date.now() });
       
        temp.searchCacheId = cacheId;
        await setState(from, "SEARCH_RESULTS_VIEW", temp);
       
        await showProfileCard(from, results[0], temp);
       
      } catch (err) {
        console.error("Filter search error:", err);
        await sendText(from, "❌ *Something went wrong*\n*कुछ गड़बड़ हुई*\n\nPlease try again.\nकृपया पुनः प्रयास करें।");
        await setState(from, "", {});
        await sendJoinSearchStopButtons(from);
      }
      return;
    }

    if (effectiveInput === "CLEAR_FILTERS") {
      temp.filters = {};
      await setState(from, "", temp);
      await sendText(from, "🔄 *Filters cleared*\n*फ़िल्टर हटा दिए गए*\n\nStarting fresh search...");
      await sendText(from, SEARCH_GENDER_MSG);
      await setState(from, "SEARCH_BRIDE_GROOM", temp);
      await sendButtons(from, "👇 *Select* / *चुनें* 👇", [
        { id: "SEARCH_BRIDE", title: "👰 BRIDE" },
        { id: "SEARCH_GROOM", title: "🤵 GROOM" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }

    // ===================== PAYMENT FLOW =====================
    if (effectiveInput === "MAKE_PAYMENT") {
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendText(from, "📝 *Please create profile first*\n*कृपया पहले प्रोफाइल बनाएं*\n\nUse JOIN to register.\nJOIN करके रजिस्टर करें।");
        await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
          { id: "JOIN", title: "📝 JOIN" },
          { id: "STOP", title: "⏹️ STOP" },
        ]);
        return;
      }
      await setState(from, "PAYMENT_SELECT_PLAN", temp);
      await sendText(from, PAYMENT_PLANS_MSG);
      await sendButtons(from, "👇 *Select your plan* / *अपना प्लान चुनें* 👇", [
        { id: "PLAN_1_3MO", title: "💰 ₹300 (3mo)" },
        { id: "PLAN_1_YEAR", title: "💝 ₹1000 (1yr)" },
        { id: "PLAN_2_YEAR", title: "💎 ₹2000 (1yr)" },
      ]);
      return;
    }

    if (st.step === "PAYMENT_SELECT_PLAN") {
      if (effectiveInput === "PLAN_1_3MO" || effectiveInput === "PLAN_1_YEAR" || effectiveInput === "PLAN_2_YEAR") {
        temp.selectedPlan = effectiveInput;
        await setState(from, "PAYMENT_QR", temp);
       
        let amount = effectiveInput === "PLAN_1_3MO" ? "₹300" : (effectiveInput === "PLAN_1_YEAR" ? "₹1000" : "₹2000");
        let planName = effectiveInput === "PLAN_1_3MO" ? "3 Months - Send Interest" : effectiveInput === "PLAN_1_YEAR" ? "1 Year - Send Interest" : "1 Year - Full Access";
       
        await sendText(from, `💳 *Payment Details / भुगतान विवरण*\n\n📋 Plan: ${planName}\n💵 Amount / राशि: ${amount}\n📱 UPI ID: ${UPI_ID}\n\n📸 *Scan QR code below to pay*\n*भुगतान के लिए नीचे QR कोड स्कैन करें*`);
       
        if (QR_IMAGE_URL) {
          await sendImageByLink(from, QR_IMAGE_URL, `📱 Scan to Pay ${amount} | भुगतान करें ${amount}`);
        } else {
          await sendText(from, "⚠️ QR code not available. Please use UPI ID above.\nQR कोड उपलब्ध नहीं है। कृपया ऊपर दी गई UPI ID का उपयोग करें।");
        }
       
        await sendButtons(from, "✅ *After payment, click below*\n*भुगतान के बाद नीचे क्लिक करें*", [
          { id: "PAYMENT_DONE", title: "✅ PAID" },
          { id: "CANCEL", title: "❌ CANCEL" },
        ]);
        return;
      }
    }

    if (st.step === "PAYMENT_QR") {
      if (effectiveInput === "PAYMENT_DONE") {
        const userProfiles = await findProfilesByPhone(from);
        if (!userProfiles.length) return;
       
        await notifyAdminPayment(from, userProfiles[0].profile_id, temp.selectedPlan || "PLAN_1_YEAR");
        await sendText(from, `✅ *Payment Confirmation Sent!*\n*भुगतान पुष्टि भेज दी गई!*\n\n⏳ Your payment is being verified.\nआपका भुगतान सत्यापित किया जा रहा है।\n\n📞 Usually approved within 24 hours.\nआमतौर पर 24 घंटे के भीतर स्वीकृत।\n\n💝 Thank you for choosing Vivaho!\nVivaho चुनने के लिए धन्यवाद!`);
        await setState(from, "", {});
        await sendJoinSearchStopButtons(from);
        return;
      }
     
      if (effectiveInput === "CANCEL") {
        await setState(from, "", {});
        await sendText(from, "❌ *Payment cancelled*\n*भुगतान रद्द*\n\nYou can make payment anytime.\nआप कभी भी भुगतान कर सकते हैं।");
        await sendJoinSearchStopButtons(from);
        return;
      }
    }

    // ===================== ADMIN PAYMENT APPROVAL =====================
    if (cmd === "ADMIN_APPROVE_1_3MO" || cmd === "ADMIN_APPROVE_1_YEAR" || cmd === "ADMIN_APPROVE_2_YEAR" || cmd === "ADMIN_REJECT") {
      if (!isAdmin(from)) { await sendText(from, "❌ *Admin access only*\n*केवल एडमिन की पहुंच*"); return; }
     
      const profileId = args[0];
      const userPhone = args[1];
      const prof = await findProfileById(profileId);
      if (!prof) { await sendText(from, "❌ Profile not found."); return; }
     
      if (cmd === "ADMIN_REJECT") {
        await sendText(userPhone, `❌ *Payment Not Verified*\n*भुगतान सत्यापित नहीं*\n\nPlease ensure payment is completed correctly.\nकृपया सुनिश्चित करें कि भुगतान सही ढंग से पूरा हुआ है।`);
        await sendText(from, `✅ Rejected payment for ${profileId}`);
        return;
      }
     
      let approvalMsg = "";
      if (cmd === "ADMIN_APPROVE_1_3MO") {
        await updateProfileApproval1(prof.rowIndex, "APPROVED", addMonths(nowISO(), 3));
        approvalMsg = `✅ *Payment Verified!*\n*भुगतान सत्यापित!* 🎉\n\n💝 *₹300 Plan Activated - 3 Months*\n✨ You can now SEND INTEREST to profiles!\n✨ अब आप प्रोफाइल पर INTEREST भेज सकते हैं!`;
      } else if (cmd === "ADMIN_APPROVE_1_YEAR") {
        await updateProfileApproval1(prof.rowIndex, "APPROVED", addYears(nowISO(), 1));
        approvalMsg = `✅ *Payment Verified!*\n*भुगतान सत्यापित!* 🎉\n\n💝 *₹1000 Plan Activated - 1 Year*\n✨ You can now SEND INTEREST to profiles!\n✨ अब आप प्रोफाइल पर INTEREST भेज सकते हैं!`;
      } else if (cmd === "ADMIN_APPROVE_2_YEAR") {
        await updateProfileApproval1(prof.rowIndex, "APPROVED", addYears(nowISO(), 1));
        await updateProfileApproval2(prof.rowIndex, "APPROVED", addYears(nowISO(), 1));
        approvalMsg = `✅ *Payment Verified!*\n*भुगतान सत्यापित!* 🎉\n\n💎 *₹2000 Premium Plan Activated - 1 Year*\n✨ You can now SEND INTEREST + VIEW CONTACT DETAILS!\n✨ अब आप INTEREST भेज सकते हैं और CONTACT DETAILS देख सकते हैं!`;
      }
     
      await sendText(userPhone, `${approvalMsg}\n\n💝 *Thank you for choosing Vivaho!*\n*Vivaho चुनने के लिए धन्यवाद!* 💝`);
      await sendText(from, `✅ Approved ${profileId} for ${userPhone}`);
      return;
    }

    // ===================== REGISTRATION FLOW =====================
    if (st.step === "ASK_NAME") {
      if (!text || text.length < 2) { await sendText(from, "❌ Please enter a valid name.\nकृपया मान्य नाम लिखें।"); return; }
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, "📝 *Enter your surname / उपनाम लिखें:*");
      return;
    }
   
    if (st.step === "ASK_SURNAME") {
      if (!text || text.length < 1) { await sendText(from, "❌ Please enter a valid surname.\nकृपया मान्य उपनाम लिखें।"); return; }
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendButtons(from, "⚥ *Select Gender / लिंग चुनें*", [
        { id: "GENDER_MALE", title: "👨 MALE" },
        { id: "GENDER_FEMALE", title: "👩 FEMALE" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
      return;
    }
   
    if (st.step === "ASK_GENDER") {
      let g = interactiveId === "GENDER_MALE" ? "male" : (interactiveId === "GENDER_FEMALE" ? "female" : normalizeGender(text));
      if (!g) { await sendText(from, "❌ Please select Male or Female.\nकृपया पुरुष या महिला चुनें।"); return; }
      temp.gender = g;
      await setState(from, "ASK_MARITAL_STATUS", temp);
      await sendList(from, "💍 *Marital Status / वैवाहिक स्थिति*", "Select", [
        { id: "MARITAL_UNMARRIED", title: "Unmarried / अविवाहित" },
        { id: "MARITAL_DIVORCE", title: "Divorced / तलाकशुदा" },
        { id: "MARITAL_WIDOW", title: "Widowed / विधुर/विधवा" },
      ]);
      return;
    }
   
    if (st.step === "ASK_MARITAL_STATUS") {
      let ms = "";
      if (interactiveId === "MARITAL_UNMARRIED") ms = "Unmarried";
      else if (interactiveId === "MARITAL_DIVORCE") ms = "Divorced";
      else if (interactiveId === "MARITAL_WIDOW") ms = "Widowed";
      if (!ms) { await sendText(from, "❌ Please select marital status.\nकृपया वैवाहिक स्थिति चुनें।"); return; }
      temp.marital_status = ms;
      await setState(from, "ASK_DOB", temp);
      await sendText(from, "📅 *Enter your Date of Birth*\n*अपनी जन्मतिथि लिखें*\n\nFormat: *DD-MM-YYYY*\nExample: 15-05-1995");
      return;
    }
   
    if (st.step === "ASK_DOB") {
      const age = calcAgeFromDobDDMMYYYY(text);
      if (age === null || age < MIN_AGE) { await sendText(from, `❌ Invalid date or age under ${MIN_AGE}.\nअमान्य तिथि या आयु ${MIN_AGE} से कम।\n\nUse DD-MM-YYYY format.`); return; }
      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, "📏 *Enter your height*\n*अपनी ऊंचाई लिखें*\n\nExamples: 5'6\", 168 cm");
      return;
    }
   
    if (st.step === "ASK_HEIGHT") {
      if (!text || text.length < 2) { await sendText(from, "❌ Please enter height.\nकृपया ऊंचाई लिखें।"); return; }
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, "🕉️ *Enter your religion*\n*अपना धर्म लिखें*\n\nExamples: Hindu, Muslim, Christian");
      return;
    }
   
    if (st.step === "ASK_RELIGION") {
      if (!text || text.length < 2) { await sendText(from, "❌ Please enter religion.\nकृपया धर्म लिखें।"); return; }
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, "👥 *Enter your caste*\n*अपनी जाति लिखें*\n\nType SKIP to skip.");
      return;
    }
   
    if (st.step === "ASK_CASTE") {
      temp.caste = isSkip(text) ? "" : text;
      await setState(from, "ASK_NATIVE_PLACE", temp);
      await sendText(from, "🏠 *Enter your native place/city*\n*अपना मूल स्थान/शहर लिखें*");
      return;
    }
   
    if (st.step === "ASK_NATIVE_PLACE") {
      if (!text || text.length < 2) { await sendText(from, "❌ Please enter native place.\nकृपया मूल स्थान लिखें।"); return; }
      temp.native_place = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, "🗺️ *Enter your district*\n*अपना जिला लिखें*");
      return;
    }
   
    if (st.step === "ASK_DISTRICT") {
      if (!text || text.length < 2) { await sendText(from, "❌ Please enter district.\nकृपया जिला लिखें।"); return; }
      temp.district = text;
      await setState(from, "ASK_WORK_CITY", temp);
      await sendText(from, "🏢 *Enter your work city*\n*अपना कार्य शहर लिखें*\n\nType SAME if same as native place.");
      return;
    }
   
    if (st.step === "ASK_WORK_CITY") {
      temp.work_city = isSame(text) ? temp.native_place : text;
      await setState(from, "ASK_WORK_DISTRICT", temp);
      await sendText(from, "🏢 *Enter your work district*\n*अपना कार्य जिला लिखें*\n\nType SAME or SKIP.");
      return;
    }
   
    if (st.step === "ASK_WORK_DISTRICT") {
      temp.work_district = isSkip(text) ? "" : (isSame(text) ? temp.district : text);
      await setState(from, "ASK_EDU", temp);
      await sendText(from, "🎓 *Enter your education*\n*अपनी शिक्षा लिखें*\n\nExamples: BE, MBA, B.Com, 12th");
      return;
    }
   
    if (st.step === "ASK_EDU") {
      if (!text || text.length < 1) { await sendText(from, "❌ Please enter education.\nकृपया शिक्षा लिखें।"); return; }
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendButtons(from, "💼 *Select job type*\n*नौकरी का प्रकार चुनें*", [
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
      if (!job) { await sendText(from, "❌ Please select job type.\nकृपया नौकरी का प्रकार चुनें।"); return; }
      temp.job = job;
      await setState(from, "ASK_JOB_TITLE", temp);
      await sendText(from, "📌 *Enter your job title/position*\n*अपना पद/पोजीशन लिखें*\n\nExamples: Software Engineer, Teacher, Doctor");
      return;
    }
   
    if (st.step === "ASK_JOB_TITLE") {
      if (!text || text.length < 2) { await sendText(from, "❌ Please enter job title.\nकृपया पद नाम लिखें।"); return; }
      temp.job_title = text;
      await setState(from, "ASK_INCOME", temp);
      await sendList(from, "💰 *Monthly Income*\n*मासिक आय*", "Select", [
        { id: "INC_1", title: "Up to ₹50,000" },
        { id: "INC_2", title: "₹50K - ₹1 Lakh" },
        { id: "INC_3", title: "₹1L - ₹3 Lakh" },
        { id: "INC_4", title: "Above ₹3 Lakh" },
      ]);
      return;
    }
   
    if (st.step === "ASK_INCOME") {
      let income = "";
      if (interactiveId === "INC_1") income = "Up to 50,000";
      else if (interactiveId === "INC_2") income = "50,000 to 1,00,000";
      else if (interactiveId === "INC_3") income = "1,00,000 to 3,00,000";
      else if (interactiveId === "INC_4") income = "Above 3,00,000";
      if (!income) { await sendText(from, "❌ Please select income.\nकृपया आय चुनें।"); return; }
      temp.income_annual = income;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, "📸 *Send your recent photo*\n*अपनी हाल की फोटो भेजें* 📸\n\n⚠️ Clear face photo required\nसाफ चेहरे की फोटो आवश्यक");
      return;
    }
   
    if (st.step === "ASK_PHOTO") {
      if (msgType !== "image") { await sendText(from, "❌ Please send a photo as image.\nकृपया इमेज के रूप में फोटो भेजें।"); return; }
     
      const mediaId = msg.image?.id;
      if (!mediaId) { await sendText(from, "❌ Photo not received. Try again.\nफोटो प्राप्त नहीं हुई।"); return; }
     
      await sendText(from, "📸 *Photo received! Creating your profile...*\n*फोटो मिल गई! प्रोफाइल बना रहे हैं...*");
     
      try {
        const metaUrl = await getMetaMediaUrl(mediaId);
        if (!metaUrl) { await sendText(from, "❌ Could not process photo.\nफोटो प्रोसेस नहीं हो सकी।"); return; }
       
        const { bytes } = await downloadMetaMediaBytes(metaUrl);
        const photoUrl = await uploadPhotoToCloudinary(bytes, `MH_${from}_${Date.now()}.jpg`);
       
        if (!photoUrl) { await sendText(from, "❌ Photo upload failed. Try again.\nफोटो अपलोड विफल।"); return; }
       
        temp.photo_url = photoUrl;
        const profileId = await createProfile(from, temp);
        await notifyAdminNewProfile(profileId, from, temp);
        await setState(from, "", {});
       
        await sendText(from, `🎉 *Registration Complete!*\n*पंजीकरण पूर्ण!* 🎉\n\n🆔 *Your Profile ID:* *${profileId}*\n*आपकी प्रोफाइल ID:* *${profileId}*\n\n✨ Congratulations! Your profile has been created.\nबधाई हो! आपकी प्रोफाइल बन गई है।\n\n━━━━━━━━━━━━━━━━━\n\n💰 *Activate Premium Features*\n*प्रीमियम सुविधाएं सक्रिय करें*\n\n💝 *₹300 - 3 Months*\n   ✓ Send Interest | रिश्ते भेजें\n\n💝 *₹1000 - 1 Year*\n   ✓ Send Interest | रिश्ते भेजें\n\n💎 *₹2000 - 1 Year (Premium)*\n   ✓ Send Interest + View Contact\n   ✓ रिश्ते भेजें + संपर्क देखें`);
       
        await sendButtons(from, "👇 *What would you like to do?* / *आप क्या करना चाहेंगे?* 👇", [
          { id: "MAKE_PAYMENT", title: "💳 MAKE PAYMENT" },
          { id: "SEARCH", title: "🔍 SEARCH" },
          { id: "JOIN", title: "🔄 NEW PROFILE" },
        ]);
       
      } catch (err) {
        console.error("Photo processing error:", err);
        await sendText(from, "❌ Error processing photo. Please try again.\nफोटो प्रोसेसिंग में त्रुटि। कृपया पुनः प्रयास करें।");
      }
      return;
    }

    // Default fallback
    if (!st.step) {
      await sendJoinSearchStopButtons(from);
    }
   
  } catch (err) {
    console.error("Webhook error:", err?.message || err);
    try {
      const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        await sendText(normalizePhone(from), "❌ *Something went wrong*\n*कुछ गड़बड़ हुई*\n\nPlease try again.\nकृपया पुनः प्रयास करें।");
      }
    } catch (e) {
      console.error("Error sending error message:", e);
    }
  }
});

// ===================== Start Server =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ${BRAND_NAME} Bot Running on Port ${PORT}`);
  console.log(`📱 WhatsApp Bot Active`);
  console.log(`🔗 QR Code: ${QR_IMAGE_URL ? "Configured" : "Not Set"}`);
  console.log(`⚡ Rate Limiting: ${MIN_MESSAGE_GAP}ms gap, ${MAX_MESSAGES_PER_MINUTE} msg/min`);
});

