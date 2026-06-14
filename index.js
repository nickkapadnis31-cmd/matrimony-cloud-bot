// index.js — Vivaho WhatsApp Matrimony Bot (Upgraded Single File)
// English-only UX | MENU system | full_name sheet | 3 free interests/day

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
  const greetings = ["HI", "HELLO", "HII", "HEY", "HY", "YO", "START", "MENU", "HOME", "VIVAHO"];
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

// ===================== English Messages =====================
const WELCOME_MSG = `✨ *Vivaho*

Find meaningful matches on WhatsApp ❤️

👇 Choose an option to continue`;

const SEARCH_GENDER_MSG = `Who are you looking for? 👇`;

const SEARCHING_MSG = `🔍 Searching matches...`;

const NO_MATCHES_MSG = `😔 No matches found yet.

Try filters or check again later ✨`;

const PROFILE_CARD_TEMPLATE = (profile, age) => `📷 *Profile ${profile.profile_id}*

🎂 Age: ${age || "NA"}
📏 Height: ${profile.height || "NA"}
🕉️ Religion: ${profile.religion || "NA"}
👥 Caste: ${profile.caste || "NA"}
💍 Marital: ${profile.marital_status || "NA"}
🎓 Education: ${profile.education || "NA"}
💼 Work: ${profile.job_title || profile.job || "NA"}
💰 Income: ${profile.income_annual || "NA"}
🏠 Native: ${profile.native_place || "NA"}
🏢 Work City: ${profile.work_city || "NA"}`;

const ACTION_BUTTONS_MSG = `👇 Pick an action`;

const PAYMENT_PLANS_MSG = `💎 *Vivaho Premium*

🆓 *Free*
✅ Search profiles
✅ Receive interests
✅ Send 3 interests/day

💝 *₹300 — 3 Months*
✅ Unlimited interests
✅ View contact details
✅ Priority visibility

💎 *₹1000 — 1 Year*
✅ Unlimited interests
✅ View contact details
✅ Priority visibility`;

const SUPPORT_PROMPT_MSG = `💬 Need help?

Type your question or issue below 👇`;

const BUSINESS_ASSOCIATE_MSG = `🤝 *Earn with Vivaho*

Help people find their perfect match and earn with us.

✅ Work from anywhere
✅ No investment
✅ Flexible timing
✅ Training & support

How it works:
1️⃣ Share Vivaho
2️⃣ Help users register
3️⃣ Approved profiles count
4️⃣ Earn commission 🚀`;

const SUCCESS_STORIES = [
  `🎉 *Success Story #1*

❤️ Rahul & Priya connected through Vivaho.

What started with a simple interest request became a beautiful relationship.

More stories coming soon ✨`,
  `🎉 *Success Story #2*

❤️ Amit & Sneha found each other through Vivaho.

Same values. Same goals. One meaningful connection ❤️`,
  `🎉 *Success Story #3*

Your story could be next ✨

Start exploring matches today ❤️`
];

const INACTIVE_REMINDER_MSG = `😔 You've been away for a while.

New profiles are waiting to be explored ❤️`; 

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
        { folder: "vivaho_profiles", resource_type: "image", transformation: [{ width: 800, crop: "limit" }, { quality: "auto" }] },
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

async function sendMainButtons(to) {
  await sendButtons(to, "👇 Choose an option", [
    { id: "JOIN", title: "💍 JOIN" },
    { id: "SEARCH", title: "🔍 SEARCH" },
    { id: "MENU", title: "📋 MENU" },
  ]);
}

// Backward compatible name used in old code.
async function sendJoinSearchStopButtons(to) {
  return sendMainButtons(to);
}

async function sendMenu(to) {
  await sendList(to, "📋 *Vivaho Menu*\\n\\nPick one option 👇", "Open Menu", [
    { id: "SEARCH", title: "🔍 Search Matches" },
    { id: "FILTER_SEARCH", title: "🔧 Filter Search" },
    { id: "MYPROFILES", title: "👤 My Profile" },
    { id: "MYFAVORITES", title: "❤️ Favorites" },
    { id: "MYINTERESTS", title: "💌 My Interests" },
    { id: "MAKE_PAYMENT", title: "💎 Premium" },
    { id: "BUSINESS_ASSOCIATE", title: "🤝 Earn with Vivaho" },
    { id: "SUCCESS_STORIES", title: "🎉 Success Stories" },
    { id: "HELP_SUPPORT", title: "❓ Help & Support" },
  ], "Vivaho");
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!A:AB` });
  return res.data.values || [];
}

function profileRowToObj(row, rowIndex1Based) {
  return {
    rowIndex: rowIndex1Based,
    profile_id: row?.[0] || "",
    phone: row?.[1] || "",
    full_name: row?.[2] || "",
    name: row?.[2] || "", // compatibility alias
    gender: cleanLower(row?.[3] || ""),
    date_of_birth: row?.[4] || "",
    religion: row?.[5] || "",
    height: row?.[6] || "",
    caste: row?.[7] || "",
    native_place: row?.[8] || "",
    district: row?.[9] || "",
    work_city: row?.[10] || "",
    work_district: row?.[11] || "",
    education: row?.[12] || "",
    job: row?.[13] || "",
    job_title: row?.[14] || "",
    income_annual: row?.[15] || "",
    photo_url: row?.[16] || "",
    approved_1: cleanUpper(row?.[17] || "PENDING"),
    approved_1_expiry: row?.[18] || "",
    approved_2: cleanUpper(row?.[19] || "PENDING"),
    approved_2_expiry: row?.[20] || "",
    created_at: row?.[21] || "",
    marital_status: row?.[22] || "",
    favorites: row?.[23] || "",
    daily_interests: row?.[24] || "0",
    last_interest_date: row?.[25] || "",
    last_active: row?.[26] || "",
    last_reminder_sent: row?.[27] || "",
  };
}

function getDisplayName(profile) {
  const full = String(profile?.full_name || profile?.name || "").trim();
  return full ? full.split(/\s+/)[0] : "Member";
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function isPremium(profile) {
  return profile?.approved_2 === "APPROVED" && !isExpired(profile?.approved_2_expiry);
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
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!R${rowIndex1Based}:S${rowIndex1Based}`, valueInputOption: "RAW", requestBody: { values: [[status, expiryDate || ""]] } });
}

async function updateProfileApproval2(rowIndex1Based, status, expiryDate) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!T${rowIndex1Based}:U${rowIndex1Based}`, valueInputOption: "RAW", requestBody: { values: [[status, expiryDate || ""]] } });
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
    profile_id, phone, temp.full_name || temp.name || "", temp.gender || "",
    temp.date_of_birth || "", temp.religion || "", temp.height || "", temp.caste || "",
    temp.native_place || "", temp.district || "", temp.work_city || "", temp.work_district || "",
    temp.education || "", temp.job || "", temp.job_title || "", temp.income_annual || "",
    temp.photo_url || "", "PENDING", "", "PENDING", "", createdAt, temp.marital_status || "",
    "", "0", "", createdAt, ""
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!A:AB`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
  return profile_id;
}



function getUserPaymentStatus(profile) {
  const premium = isPremium(profile);
  return { canSendInterest: premium, canViewContact: premium, isPremium: premium };
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
async function updateRequestStatus(rowIndex, status) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${REQUESTS_TAB}!D${rowIndex}:D${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[status]] }
  });
}

async function getReceivedInterests(profileId) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${REQUESTS_TAB}!A:G` });
  const rows = res.data.values || [];
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]?.[2] === profileId && rows[i]?.[5] === "INTEREST" && rows[i]?.[3] === "SENT") {
      list.push({ rowIndex: i + 1, from_profile_id: rows[i]?.[1], created_at: rows[i]?.[4] || "" });
    }
  }
  return list;
}

async function updateProfileExtras(rowIndex, values) {
  const sheets = await getSheetsClient();
  const current = await findProfileById(values.profile_id || "");
  const fav = values.favorites !== undefined ? values.favorites : (current?.favorites || "");
  const daily = values.daily_interests !== undefined ? values.daily_interests : (current?.daily_interests || "0");
  const lastDate = values.last_interest_date !== undefined ? values.last_interest_date : (current?.last_interest_date || "");
  const lastActive = values.last_active !== undefined ? values.last_active : (current?.last_active || "");
  const lastReminder = values.last_reminder_sent !== undefined ? values.last_reminder_sent : (current?.last_reminder_sent || "");
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!X${rowIndex}:AB${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[fav, daily, lastDate, lastActive, lastReminder]] }
  });
}

async function touchLastActive(phone) {
  try {
    const profiles = await findProfilesByPhone(phone);
    if (!profiles.length) return;
    const p = profiles[0];
    await updateProfileExtras(p.rowIndex, { profile_id: p.profile_id, last_active: nowISO() });
  } catch (e) {
    console.error("touchLastActive failed:", e.message);
  }
}

async function updateDailyInterest(profile, count, date) {
  await updateProfileExtras(profile.rowIndex, {
    profile_id: profile.profile_id,
    daily_interests: String(count),
    last_interest_date: date
  });
}

async function saveFavoriteForUser(userProfile, targetProfileId) {
  const set = new Set(String(userProfile.favorites || "").split(",").map(x => x.trim()).filter(Boolean));
  set.add(targetProfileId);
  await updateProfileExtras(userProfile.rowIndex, {
    profile_id: userProfile.profile_id,
    favorites: Array.from(set).join(",")
  });
}



// ===================== Admin Notifications =====================
async function notifyAdminNewProfile(profileId, phone, temp) {
  if (!ADMIN_PHONE) return;
  await sendText(ADMIN_PHONE, `🆕 New registration

🆔 ${profileId}
📱 ${phone}
👤 ${temp.full_name || temp.name || ""}
⚥ ${temp.gender || ""}
📅 ${temp.date_of_birth || ""}`);
}

async function notifyAdminPayment(userPhone, profileId, planType) {
  if (!ADMIN_PHONE) return;
  let planMsg = "", buttons = [];
  if (planType === "PLAN_1_3MO") {
    planMsg = "₹300 for 3 months — Full Access";
    buttons = [{ id: `ADMIN_APPROVE_1_3MO_${profileId}_${userPhone}`, title: "APPROVE ₹300" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  } else {
    planMsg = "₹1000 for 1 year — Full Access";
    buttons = [{ id: `ADMIN_APPROVE_1_YEAR_${profileId}_${userPhone}`, title: "APPROVE ₹1000" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  }
  await sendText(ADMIN_PHONE, `💰 Payment received

👤 User: ${userPhone}
🆔 Profile: ${profileId}
💳 Plan: ${planMsg}`);
  await sendButtons(ADMIN_PHONE, `Action for ${profileId}`, buttons);
}



// ===================== Search Helpers =====================
async function getAllVisibleProfiles() {
  const rows = await getAllProfilesRows();
  const allProfiles = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
    const obj = profileRowToObj(row, i + 1);
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

  await sendButtons(to, ACTION_BUTTONS_MSG, [
    { id: "SEND_INTEREST", title: "💌 INTEREST" },
    { id: "SAVE_PROFILE", title: "⭐ SAVE" },
    { id: "NEXT", title: "➡️ NEXT" },
  ]);
}

async function showFilterMenu(to) {
  await setState(to, "FILTER_GENDER", {});
  await sendText(to, "🔧 Filter Search");
  await sendButtons(to, "Who are you looking for?", [
    { id: "FILTER_BRIDE", title: "👰 BRIDE" },
    { id: "FILTER_GROOM", title: "🤵 GROOM" },
    { id: "MENU", title: "📋 MENU" },
  ]);
}



async function sendNotRegisteredMessage(to) {
  await sendText(to, `📝 Create your profile first.

Join now and start exploring matches ❤️`);
  await sendMainButtons(to);
}

async function sendPremiumPlans(to) {
  await sendText(to, PAYMENT_PLANS_MSG);
  await sendButtons(to, "Choose a plan 👇", [
    { id: "PLAN_1_3MO", title: "₹300 / 3mo" },
    { id: "PLAN_1_YEAR", title: "₹1000 / 1yr" },
    { id: "MENU", title: "📋 MENU" },
  ]);
}

async function showSuccessStory(to, temp = {}) {
  const index = Number(temp.successIndex || 0);
  const story = SUCCESS_STORIES[index % SUCCESS_STORIES.length];
  temp.successIndex = (index + 1) % SUCCESS_STORIES.length;
  await setState(to, "SUCCESS_STORIES_VIEW", temp);
  await sendText(to, story);
  await sendButtons(to, "Want to see more?", [
    { id: "NEXT_STORY", title: "➡️ NEXT" },
    { id: "MENU", title: "📋 MENU" },
  ]);
}

async function showBusinessAssociate(to) {
  await sendText(to, BUSINESS_ASSOCIATE_MSG);
  await sendButtons(to, "Choose an option 👇", [
    { id: "JOIN_ASSOCIATE", title: "📝 JOIN" },
    { id: "EARNING_EXAMPLES", title: "📊 EXAMPLES" },
    { id: "HELP_SUPPORT", title: "❓ HELP" },
  ]);
}

async function showEarningExamples(to) {
  await sendText(to, `📊 *Earning Examples*

5 registrations = ₹1,000
10 registrations = ₹2,000
25 registrations = ₹5,000
50 registrations = ₹10,000+

No fixed limit. Grow your network 🚀`);
  await sendButtons(to, "Need help?", [
    { id: "HELP_SUPPORT", title: "❓ SUPPORT" },
    { id: "MENU", title: "📋 MENU" },
  ]);
}

async function showMyFavorites(to) {
  const userProfiles = await findProfilesByPhone(to);
  if (!userProfiles.length) return sendNotRegisteredMessage(to);
  const favorites = String(userProfiles[0].favorites || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!favorites.length) {
    await sendText(to, "❤️ No saved profiles yet.");
    await sendMainButtons(to);
    return;
  }
  await sendText(to, `❤️ You saved ${favorites.length} profile(s).`);
  for (const id of favorites.slice(0, 3)) {
    const p = await findProfileById(id);
    if (p) await showProfileCard(to, p, {});
  }
}

async function showMyInterests(to) {
  const profiles = await findProfilesByPhone(to);
  if (!profiles.length) return sendNotRegisteredMessage(to);
  const pending = await getReceivedInterests(profiles[0].profile_id);
  if (!pending.length) {
    await sendText(to, "💌 No new interests right now.");
    await sendMainButtons(to);
    return;
  }
  let msg = `💌 You have ${pending.length} interest(s) ❤️\\n\\n`;
  for (const req of pending.slice(0, 5)) {
    const p = await findProfileById(req.from_profile_id);
    msg += `• ${req.from_profile_id}${p ? " — " + getDisplayName(p) : ""}\\n`;
  }
  msg += `\\nReply like:\\nACCEPT MH-XXXX\\nREJECT MH-XXXX`;
  await sendText(to, msg);
  await sendButtons(to, "Pick an option", [
    { id: "SEARCH", title: "🔍 SEARCH" },
    { id: "MENU", title: "📋 MENU" },
  ]);
}



// ===================== handleDirectCommand =====================
async function handleDirectCommand(from, cmd, args, temp, st) {
  if (cmd === "MENU") {
    await setState(from, "", {});
    await sendMenu(from);
    return;
  }

  if (cmd === "PREMIUM" || cmd === "PLANS") {
    await sendPremiumPlans(from);
    return;
  }

  if (cmd === "MYFAVORITES") {
    await showMyFavorites(from);
    return;
  }

  if (cmd === "MYINTERESTS") {
    await showMyInterests(from);
    return;
  }

  if (cmd === "SUCCESS" || cmd === "SUCCESS_STORIES") {
    await showSuccessStory(from, temp);
    return;
  }

  if (cmd === "BUSINESS" || cmd === "BUSINESS_ASSOCIATE") {
    await showBusinessAssociate(from);
    return;
  }

  if (cmd === "HELP" || cmd === "HELP_SUPPORT") {
    await setState(from, "ASK_SUPPORT", {});
    await sendText(from, SUPPORT_PROMPT_MSG);
    return;
  }

  if (cmd === "SEARCHID") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "Use: SEARCHID MH-XXXX"); return; }
    const p = await findProfileById(profileId);
    if (!p) { await sendText(from, "Profile not found."); return; }
    await showProfileCard(from, p, temp || {});
    return;
  }


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
      { id: "MENU", title: "📋 MENU" },
    ]);
    return;
  }

  if (cmd === "NEXT") {
    const cacheId = temp.searchCacheId;
    const cache = global.searchCache?.get(cacheId);

    if (!cache || !cache.results || !cache.results.length) {
      await sendText(from, "No active search. Tap Search to start.");
      await sendMainButtons(from);
      return;
    }

    let newIndex = cache.index + 1;
    if (newIndex >= cache.results.length) {
      await sendText(from, "You've seen all profiles in this search ✨");
      await sendButtons(from, "Try again?", [
        { id: "SEARCH", title: "🔍 SEARCH" },
        { id: "FILTER_SEARCH", title: "🔧 FILTER" },
        { id: "MENU", title: "📋 MENU" },
      ]);
      return;
    }
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
    if (!profileId) { await sendText(from, "Use: INTEREST MH-XXXX"); return; }

    const userProfiles = await findProfilesByPhone(from);
    if (!userProfiles.length) {
      await sendNotRegisteredMessage(from);
      return;
    }

    const userProfile = userProfiles[0];
    if (userProfile.profile_id === profileId) { await sendText(from, "You can't send interest to yourself 🙂"); return; }

    const target = await findProfileById(profileId);
    if (!target) { await sendText(from, "Profile not found."); return; }

    const existing = await findInterestRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id });
    if (existing && existing.status === "SENT") { await sendText(from, "Interest already sent ❤️"); return; }

    const premium = isPremium(userProfile);
    if (!premium) {
      const today = todayISODate();
      let count = Number(userProfile.daily_interests || 0);
      if (userProfile.last_interest_date !== today) count = 0;
      if (count >= 3) {
        await sendText(from, `⚠️ You've used your 3 free interests today.

Upgrade to Premium for unlimited interests + contact details 💎`);
        await sendButtons(from, "Unlock Premium?", [
          { id: "MAKE_PAYMENT", title: "💎 PREMIUM" },
          { id: "MENU", title: "📋 MENU" },
        ]);
        return;
      }
      await updateDailyInterest(userProfile, count + 1, today);
    }

    await appendRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id, status: "SENT", type: "INTEREST", viewer_phone: from });

    await sendText(target.phone, `💌 New interest received ❤️

Open *My Interests* from Menu to review.`);
    await sendButtons(target.phone, "Open now?", [
      { id: "MYINTERESTS", title: "💌 INTERESTS" },
      { id: "MENU", title: "📋 MENU" },
    ]);

    await sendText(from, `✅ Interest sent!

To: ${profileId} ❤️`);
    await sendMainButtons(from);
    return;
  }

  if (cmd === "ACCEPT" || cmd === "REJECT") {
    const interestedProfileId = normalizeProfileId(args[0]);
    if (!interestedProfileId) { await sendText(from, "Use: ACCEPT MH-XXXX or REJECT MH-XXXX"); return; }

    const receiverProfiles = await findProfilesByPhone(from);
    if (!receiverProfiles.length) { await sendNotRegisteredMessage(from); return; }

    const receiverActive = receiverProfiles[0];
    const existing = await findInterestRequest({ from_profile_id: interestedProfileId, to_profile_id: receiverActive.profile_id });
    if (!existing || existing.status !== "SENT") { await sendText(from, "No pending interest found."); return; }

    const senderProfile = await findProfileById(interestedProfileId);

    if (cmd === "REJECT") {
      await updateRequestStatus(existing.rowIndex, "REJECTED");
      await sendText(from, `Interest declined.

From: ${interestedProfileId}`);
      if (senderProfile) await sendText(senderProfile.phone, `Your interest was not accepted by ${receiverActive.profile_id}.

Keep exploring more matches ❤️`);
      await sendMainButtons(from);
      return;
    }

    await updateRequestStatus(existing.rowIndex, "ACCEPTED");
    await sendText(from, `✅ Interest accepted!

Connecting you both ❤️`);

    const receiverPremium = isPremium(receiverActive);
    const senderPremium = senderProfile ? isPremium(senderProfile) : false;

    if (senderProfile && receiverPremium) {
      await sendText(from, `📞 Contact Details

👤 ${senderProfile.full_name || "NA"}
🆔 ${senderProfile.profile_id}
📱 ${senderProfile.phone}`);
    }

    if (senderProfile) {
      if (senderPremium) {
        await sendText(senderProfile.phone, `🎉 Great news!

Your interest was accepted by ${receiverActive.profile_id} ❤️

📞 Contact Details
👤 ${receiverActive.full_name || "NA"}
🆔 ${receiverActive.profile_id}
📱 ${receiverActive.phone}`);
      } else {
        await sendText(senderProfile.phone, `🎉 Great news!

Your interest was accepted by ${receiverActive.profile_id} ❤️

Upgrade to Premium to view contact details 💎`);
      }
    }

    await sendMainButtons(from);
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
    else if (interactiveId === "MENU") effectiveInput = "MENU";
    else if (interactiveId === "SAVE_PROFILE") effectiveInput = "SAVE_PROFILE";
    else if (interactiveId === "MYFAVORITES") effectiveInput = "MYFAVORITES";
    else if (interactiveId === "MYINTERESTS") effectiveInput = "MYINTERESTS";
    else if (interactiveId === "SUCCESS_STORIES") effectiveInput = "SUCCESS_STORIES";
    else if (interactiveId === "NEXT_STORY") effectiveInput = "NEXT_STORY";
    else if (interactiveId === "BUSINESS_ASSOCIATE") effectiveInput = "BUSINESS_ASSOCIATE";
    else if (interactiveId === "JOIN_ASSOCIATE") effectiveInput = "HELP_SUPPORT";
    else if (interactiveId === "EARNING_EXAMPLES") effectiveInput = "EARNING_EXAMPLES";
    else if (interactiveId === "HELP_SUPPORT") effectiveInput = "HELP_SUPPORT";
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
    const isGreetingText = isGreeting(text) && !isButtonClick;

    // Update last active in background. It should not slow the reply.
    touchLastActive(from).catch(() => {});

    if (cmd === "MENU") {
      await setState(from, "", {});
      await sendMenu(from);
      return;
    }

    if (isGreetingText) {
      await setState(from, "", {});
      await sendText(from, WELCOME_MSG);
      await sendMainButtons(from);
      return;
    }

    if (cmd === "PREMIUM" || cmd === "PLANS") { await sendPremiumPlans(from); return; }
    if (cmd === "MYFAVORITES") { await handleDirectCommand(from, "MYFAVORITES", [], temp, st); return; }
    if (cmd === "MYINTERESTS") { await handleDirectCommand(from, "MYINTERESTS", [], temp, st); return; }
    if (cmd === "SUCCESS" || cmd === "SUCCESS_STORIES") { await handleDirectCommand(from, "SUCCESS_STORIES", [], temp, st); return; }
    if (cmd === "BUSINESS" || cmd === "BUSINESS_ASSOCIATE") { await handleDirectCommand(from, "BUSINESS_ASSOCIATE", [], temp, st); return; }
    if (cmd === "HELP" || cmd === "HELP_SUPPORT") { await handleDirectCommand(from, "HELP_SUPPORT", [], temp, st); return; }
    if (cmd === "SEARCHID") { await handleDirectCommand(from, "SEARCHID", args, temp, st); return; }
    if (cmd === "SAVE") { effectiveInput = "SAVE_PROFILE"; }

    if (effectiveInput === "SAVE_PROFILE") {
      if (!temp.currentViewingProfile) { await sendText(from, "No profile selected."); return; }
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) { await sendNotRegisteredMessage(from); return; }
      await saveFavoriteForUser(userProfiles[0], temp.currentViewingProfile.profile_id);
      await sendText(from, "⭐ Saved to Favorites");
      await sendButtons(from, "Next?", [
        { id: "NEXT", title: "➡️ NEXT" },
        { id: "MYFAVORITES", title: "❤️ FAVORITES" },
        { id: "MENU", title: "📋 MENU" },
      ]);
      return;
    }

    if (effectiveInput === "NEXT_STORY") {
      await showSuccessStory(from, temp);
      return;
    }

    if (effectiveInput === "EARNING_EXAMPLES") {
      await showEarningExamples(from);
      return;
    }

    if (st.step === "ASK_SUPPORT") {
      if (!text || text.length < 2) { await sendText(from, "Please type your message 👇"); return; }
      if (ADMIN_PHONE) {
        await sendText(ADMIN_PHONE, `🆘 Vivaho Support Request

📱 User: ${from}

📝 Message:
${text}

🕒 ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
      }
      await setState(from, "", {});
      await sendText(from, "✅ Got it!\\n\\nOur team will review your message soon ❤️");
      await sendMainButtons(from);
      return;
    }

    if (!st.step && !interactiveId && text && !["JOIN","SEARCH","MENU","NEXT","MYPROFILES","DELETE","DETAILS","INTEREST","ACCEPT","REJECT","SEARCHID","MYFAVORITES","MYINTERESTS"].includes(cmd)) {
      await sendText(from, "👇 Pick an option to continue");
      await sendMainButtons(from);
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
          { id: "MENU", title: "📋 MENU" },
        ]);
        return;
      }
      await setState(from, "ASK_NAME", {});
      await sendText(from, "👤 What's your full name?");
      return;
    }

    if (cmd === "SEARCH") {
      await handleDirectCommand(from, "SEARCH", [], temp, st);
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
            { id: "MENU", title: "📋 MENU" },
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
            { id: "MENU", title: "📋 MENU" },
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
          { id: "MENU", title: "📋 MENU" },
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
          { id: "MENU", title: "📋 MENU" },
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
      if (!isPremium(userProfiles[0])) {
        await sendText(from, `🔒 Premium only

Upgrade to view contact details 💎`);
        await sendButtons(from, "Unlock Premium?", [
          { id: "MAKE_PAYMENT", title: "💎 PREMIUM" },
          { id: "NEXT", title: "➡️ NEXT" },
          { id: "MENU", title: "📋 MENU" },
        ]);
        return;
      }
      const target = temp.currentViewingProfile;
      await sendText(from, `📞 Contact Details

👤 ${target.full_name || "NA"}
🆔 ${target.profile_id}
📱 ${target.phone}

Best wishes from Vivaho ❤️`);
      await sendMainButtons(from);
      return;
    }

    // ===================== MODIFICATION 2 & 3: FILTER SEARCH FLOW =====================
    if (effectiveInput === "FILTER_SEARCH") {
      await showFilterMenu(from);
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
          { id: "MENU", title: "📋 MENU" },
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
        { id: "MENU", title: "📋 MENU" },
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
        { id: "MENU", title: "📋 MENU" },
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
      await sendList(from, "💍 Marital Status", "Select", [
        { id: "MS_UNMARRIED", title: "Unmarried" },
        { id: "MS_DIVORCED", title: "Divorced" },
        { id: "MS_WIDOWED", title: "Widowed" },
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
            { id: "MENU", title: "📋 MENU" },
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
        { id: "MENU", title: "📋 MENU" },
      ]);
      return;
    }

    // ===================== PAYMENT FLOW =====================
    if (effectiveInput === "MAKE_PAYMENT") {
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendText(from, "Create your profile first ❤️");
        await sendButtons(from, "Start now?", [
          { id: "JOIN", title: "💍 JOIN" },
          { id: "MENU", title: "📋 MENU" },
        ]);
        return;
      }
      await setState(from, "PAYMENT_SELECT_PLAN", temp);
      await sendPremiumPlans(from);
      return;
    }

    if (st.step === "PAYMENT_SELECT_PLAN") {
      if (effectiveInput === "PLAN_1_3MO" || effectiveInput === "PLAN_1_YEAR") {
        temp.selectedPlan = effectiveInput;
        await setState(from, "PAYMENT_QR", temp);

        let amount = effectiveInput === "PLAN_1_3MO" ? "₹300" : "₹1000";
        let planName = effectiveInput === "PLAN_1_3MO" ? "Premium — 3 Months" : "Premium — 1 Year";

        await sendText(from, `💳 *Payment Details*

Plan: ${planName}
Amount: ${amount}
UPI ID: ${UPI_ID}

Scan QR below and pay 👇`);

        if (QR_IMAGE_URL) {
          await sendImageByLink(from, QR_IMAGE_URL, `Scan to Pay ${amount}`);
        } else {
          await sendText(from, "QR not available. Please use the UPI ID above.");
        }

        await sendButtons(from, "After payment 👇", [
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
        await sendText(from, `✅ Payment received!

We're checking it now. You'll be updated soon 🚀`);
        await setState(from, "", {});
        await sendJoinSearchStopButtons(from);
        return;
      }
     
      if (effectiveInput === "CANCEL") {
        await setState(from, "", {});
        await sendText(from, "Payment cancelled. You can upgrade anytime 💎");
        await sendJoinSearchStopButtons(from);
        return;
      }
    }

    // ===================== ADMIN PAYMENT APPROVAL =====================
    if (cmd === "ADMIN_APPROVE_1_3MO" || cmd === "ADMIN_APPROVE_1_YEAR" || cmd === "ADMIN_REJECT") {
      if (!isAdmin(from)) { await sendText(from, "Admin access only."); return; }

      const profileId = args[0];
      const userPhone = args[1];
      const prof = await findProfileById(profileId);
      if (!prof) { await sendText(from, "Profile not found."); return; }

      if (cmd === "ADMIN_REJECT") {
        await sendText(userPhone, `❌ Payment not verified.

Please check and try again.`);
        await sendText(from, `Rejected payment for ${profileId}`);
        return;
      }

      let expiry = cmd === "ADMIN_APPROVE_1_3MO" ? addMonths(nowISO(), 3) : addYears(nowISO(), 1);
      let planText = cmd === "ADMIN_APPROVE_1_3MO" ? "₹300 Premium — 3 Months" : "₹1000 Premium — 1 Year";

      await updateProfileApproval1(prof.rowIndex, "APPROVED", expiry);
      await updateProfileApproval2(prof.rowIndex, "APPROVED", expiry);

      await sendText(userPhone, `✅ Payment verified!

${planText} activated 🎉

You now have:
✅ Unlimited interests
✅ Contact details
✅ Priority visibility`);
      await sendText(from, `Approved ${profileId} for ${userPhone}`);
      return;
    }

    // ===================== REGISTRATION FLOW =====================
    if (st.step === "ASK_NAME") {
      if (!text || text.length < 2) { await sendText(from, "Please enter a valid full name."); return; }
      temp.full_name = text;
      await setState(from, "ASK_GENDER", temp);
      await sendButtons(from, "Select gender 👇", [
        { id: "GENDER_MALE", title: "👨 MALE" },
        { id: "GENDER_FEMALE", title: "👩 FEMALE" },
        { id: "MENU", title: "📋 MENU" },
      ]);
      return;
    }

    if (st.step === "ASK_GENDER") {
      let g = interactiveId === "GENDER_MALE" ? "male" : (interactiveId === "GENDER_FEMALE" ? "female" : normalizeGender(text));
      if (!g) { await sendText(from, "❌ Please select Male or Female.\nकृपया पुरुष या महिला चुनें।"); return; }
      temp.gender = g;
      await setState(from, "ASK_MARITAL_STATUS", temp);
      await sendList(from, "💍 Marital Status", "Select", [
        { id: "MARITAL_UNMARRIED", title: "Unmarried" },
        { id: "MARITAL_DIVORCE", title: "Divorced" },
        { id: "MARITAL_WIDOW", title: "Widowed" },
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
       
        await sendText(from, `🎉 Profile created!

Your Profile ID: *${profileId}*

Start exploring matches now ❤️

${PAYMENT_PLANS_MSG}`);
       
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

