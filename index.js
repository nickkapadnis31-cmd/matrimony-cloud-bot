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

function incomeBandRank(v) {
  const x = cleanLower(v);
  if (x.includes("above 3") || x.includes("3l+") || x.includes("3,00,000")) return 4;
  if (x.includes("1,00,000") || x.includes("1l - 3l") || x.includes("1l – 3l") || x.includes("1l-3l")) return 3;
  if ((x.includes("50") && x.includes("1l")) || x.includes("50,000 to 1,00,000")) return 2;
  if (x.includes("up to 50") || x.includes("upto 50")) return 1;
  return null;
}

function educationRank(edu) {
  const e = (edu || "").toLowerCase();
  if (e.includes("phd") || e.includes("doctor")) return 4;
  if (e.includes("mba") || e.includes("mtech") || e.includes("ms") || e.includes("post")) return 3;
  if (e.includes("be") || e.includes("btech") || e.includes("b.") || e.includes("graduate")) return 2;
  return 1;
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

const SEARCHING_MSG = `🔍 *Searching for matches...* ⏳\n*मैच ढूंढे जा रहे हैं...*`;

const NO_MATCHES_MSG = `😔 *No matches found at this moment*\n*इस समय कोई मैच नहीं मिला*\n\n💫 *Try again later or create a profile to get discovered*\n*बाद में पुनः प्रयास करें या प्रोफाइल बनाएं*`;

const PROFILE_CARD_TEMPLATE = (profile, age) => `📷 *Profile ${profile.profile_id}*\n\n🎂 Age / उम्र: ${age || "NA"}\n📏 Height / ऊंचाई: ${profile.height || "NA"}\n🕉️ Religion / धर्म: ${profile.religion || "NA"}\n👥 Caste / जात: ${profile.caste || "NA"}\n💍 Marital / वैवाहिक: ${profile.marital_status || "NA"}\n🎓 Education / शिक्षा: ${profile.education || "NA"}\n💼 Job / नौकरी: ${profile.job_title || profile.job || "NA"}\n💰 Income / आय: ${profile.income_annual || "NA"}\n🏠 Native / मूल स्थान: ${profile.native_place || "NA"}\n🏢 Work / कार्य स्थल: ${profile.work_city || "NA"}`;

const ACTION_BUTTONS_MSG = `👇 *Choose action* / *कोई कार्य चुनें* 👇`;

const PAYMENT_PLANS_MSG = `💰 *Premium Plans / प्रीमियम प्लान*\n\n💝 *₹300 - 3 Months*\n   ✓ Send Interest | रिश्ते भेजें\n\n💝 *₹1000 - 1 Year*\n   ✓ Send Interest | रिश्ते भेजें\n\n💎 *₹2000 - 1 Year (Premium)*\n   ✓ Send Interest + View Contact\n   ✓ रिश्ते भेजें + संपर्क देखें`;

const FILTER_INTRO_MSG = `🔧 *Advanced Search Filters*\n*उन्नत खोज फ़िल्टर*\n\nNarrow down matches by:\nइनके अनुसार मैच फ़िल्टर करें:\n\n🎂 Age Range | उम्र सीमा\n💍 Marital Status | वैवाहिक स्थिति\n🕉️ Religion | धर्म\n👥 Caste | जाति\n🎓 Education | शिक्षा\n💰 Income | आय`;

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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!A:U` });
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
    status: cleanUpper(row?.[18] || "PENDING"),
    created_at: row?.[19] || "",
    marital_status: row?.[20] || "",
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

async function updateProfileStatus(rowIndex1Based, newStatus) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!S${rowIndex1Based}`, valueInputOption: "RAW", requestBody: { values: [[newStatus]] } });
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
    temp.photo_url || "", "PENDING", createdAt, temp.marital_status || ""
  ];
  await sheets.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: `${PROFILE_TAB}!A:U`, valueInputOption: "RAW", requestBody: { values: [row] } });
  return profile_id;
}

function getLatestApprovedProfile(profiles) {
  for (let i = profiles.length - 1; i >= 0; i--) {
    if (cleanUpper(profiles[i].status) === "APPROVED") return profiles[i];
  }
  return null;
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
  await sendButtons(ADMIN_PHONE, `Action for ${profileId}`, [
    { id: `ADMIN_APPROVE_${profileId}`, title: "APPROVE" },
    { id: `ADMIN_REJECT_${profileId}`, title: "REJECT" },
  ]);
}

// ===================== Search & Filter Helpers =====================
function applyFilters(profiles, filters, userProfile) {
  let results = [...profiles];
  
  // Only APPROVED profiles
  results = results.filter(p => cleanUpper(p.status) === "APPROVED");
  
  // Exclude own profile
  if (filters.excludeProfileId) {
    results = results.filter(p => p.profile_id !== filters.excludeProfileId);
  }
  
  // Filter by gender
  if (filters.targetGender) {
    results = results.filter(p => p.gender === filters.targetGender);
  }
  
  // Filter by age range
  if (filters.ageMin !== null || filters.ageMax !== null) {
    results = results.filter(p => {
      const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);
      if (age === null) return false;
      if (filters.ageMin !== null && age < filters.ageMin) return false;
      if (filters.ageMax !== null && age > filters.ageMax) return false;
      return true;
    });
  }
  
  // Filter by marital status
  if (filters.maritalStatus && filters.maritalStatus !== "ANY") {
    results = results.filter(p => cleanLower(p.marital_status) === cleanLower(filters.maritalStatus));
  }
  
  // Filter by religion
  if (filters.religion) {
    results = results.filter(p => cleanLower(p.religion) === cleanLower(filters.religion));
  }
  
  // Filter by caste (same caste)
  if (filters.casteScope === "SAME_CASTE" && userProfile?.caste) {
    results = results.filter(p => cleanLower(p.caste) === cleanLower(userProfile.caste));
  }
  
  // Filter by education minimum
  if (filters.eduMinRank !== null) {
    results = results.filter(p => educationRank(p.education) >= filters.eduMinRank);
  }
  
  // Filter by income minimum
  if (filters.incomeMinRank !== null) {
    results = results.filter(p => {
      const rank = incomeBandRank(p.income_annual);
      return rank !== null && rank >= filters.incomeMinRank;
    });
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
    { id: "SELECT_ACTION", title: "🎯 SELECT" },
    { id: "NEXT", title: "⏩ NEXT" },
  ]);
}

async function sendNotRegisteredMessage(to) {
  await sendText(to, `❌ *Registration Required*\n*पंजीकरण आवश्यक है*\n\n📝 Please JOIN and create your profile to access this feature.\nकृपया इस सुविधा का उपयोग करने के लिए JOIN करें और अपनी प्रोफाइल बनाएं।`);
  await sendButtons(to, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
    { id: "JOIN", title: "📝 JOIN" },
    { id: "SEARCH", title: "🔍 SEARCH" },
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
      const status = p.status === "APPROVED" ? "✅ ACTIVE" : "⏳ PENDING";
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

  if (cmd === "NEXT") {
    const cacheId = temp.searchCacheId;
    const cache = global.searchCache?.get(cacheId);
    
    if (!cache || !cache.results || !cache.results.length) {
      await sendText(from, "❌ *No active search*\n*कोई सक्रिय खोज नहीं*\n\nType SEARCH to start\nSEARCH टाइप करें।");
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
      ]);
      return; 
    }
    
    const userProfile = getLatestApprovedProfile(userProfiles);
    if (!userProfile) { 
      await sendText(from, "⏳ *Approval Pending*\n*स्वीकृति लंबित*\n\nYour profile is not yet approved.\nआपकी प्रोफाइल अभी तक स्वीकृत नहीं है।");
      return; 
    }
    
    if (userProfile.profile_id === profileId) { await sendText(from, "❌ *Cannot send interest to yourself*\n*अपने आप को interest नहीं भेज सकते*"); return; }
    
    const target = await findProfileById(profileId);
    if (!target || cleanUpper(target.status) !== "APPROVED") { await sendText(from, "❌ *Profile not found or not approved*\n*प्रोफाइल नहीं मिली या स्वीकृत नहीं*"); return; }
    
    const existing = await findInterestRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id });
    if (existing && existing.status === "SENT") { await sendText(from, "ℹ️ *Interest already sent*\n*Interest पहले ही भेजा जा चुका है*"); return; }
    
    await appendRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id, status: "SENT", type: "INTEREST", viewer_phone: from });
    await sendButtons(target.phone, `💌 *New Interest!*\n*नया रिश्ता!*\n\nSomeone is interested in your profile!\nकिसी ने आपकी प्रोफाइल में रुचि दिखाई है!\n\nFrom / से: ${userProfile.profile_id}`, [
      { id: `ACCEPT_${userProfile.profile_id}`, title: "✅ ACCEPT" },
      { id: `REJECT_${userProfile.profile_id}`, title: "❌ REJECT" },
    ]);
    await sendText(from, `✅ *Interest sent successfully!*\n*रिश्ता सफलतापूर्वक भेजा गया!*\n\nTo / को: ${profileId}\n\n💫 You'll be notified if they respond.\nउनके जवाब देने पर आपको सूचित किया जाएगा।`);
    return;
  }

  if (cmd === "ACCEPT" || cmd === "REJECT") {
    const interestedProfileId = normalizeProfileId(args[0]);
    if (!interestedProfileId) { await sendText(from, "❌ *Usage / उपयोग:* ACCEPT MH-XXXX or REJECT MH-XXXX"); return; }
    
    const receiverProfiles = await findProfilesByPhone(from);
    const receiverActive = getLatestApprovedProfile(receiverProfiles);
    if (!receiverActive) { await sendText(from, "❌ *No approved profile found*\n*कोई स्वीकृत प्रोफाइल नहीं मिली*\n\nPlease JOIN first.\nकृपया पहले JOIN करें।"); return; }
    
    const existing = await findInterestRequest({ from_profile_id: interestedProfileId, to_profile_id: receiverActive.profile_id });
    if (!existing || existing.status !== "SENT") { await sendText(from, "ℹ️ *No pending interest found*\n*कोई लंबित रिश्ता नहीं मिला*"); return; }
    
    const senderProfile = await findProfileById(interestedProfileId);
    
    if (cmd === "REJECT") {
      await sendText(from, `❌ *Interest rejected*\n*रिश्ता अस्वीकृत*\n\nFrom: ${interestedProfileId}`);
      if (senderProfile) await sendText(senderProfile.phone, `❌ *Interest Declined*\n*रिश्ता अस्वीकृत*\n\nYour interest was not accepted by ${receiverActive.profile_id}\nआपका रिश्ता ${receiverActive.profile_id} द्वारा स्वीकार नहीं किया गया।\n\n💫 Keep searching! More matches await!\nखोजते रहें! और भी मैच आपका इंतजार कर रहे हैं!`);
      return;
    }
    
    await sendText(from, `✅ *Interest Accepted!*\n*रिश्ता स्वीकृत!*\n\nFrom: ${interestedProfileId}\n\n📞 Contact: ${senderProfile ? senderProfile.phone : "N/A"}`);
    if (senderProfile) {
      await sendText(senderProfile.phone, `🎉 *Great News!*\n*शानदार खबर!* 🎉\n\n✅ Your interest was accepted!\nआपका रिश्ता स्वीकार कर लिया गया!\n\n📞 Contact: ${receiverActive.phone}\n\n💝 *Best wishes from Vivaho!*\n*Vivaho की ओर से शुभकामनाएं!* 💝`);
    }
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
    
    // Webhook debounce
    const now = Date.now();
    const lastProcessed = lastWebhookProcessed.get(from) || 0;
    if (now - lastProcessed < WEBHOOK_DEBOUNCE_MS) return;
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
        if (Date.now() - val.timestamp > 60 * 60 * 1000) global.searchCache.delete(key);
      }
    }

    const isButtonClick = !!interactiveId;
    
    if (interactiveId.startsWith("ACCEPT_")) effectiveInput = `ACCEPT ${interactiveId.replace("ACCEPT_", "")}`;
    else if (interactiveId.startsWith("REJECT_")) effectiveInput = `REJECT ${interactiveId.replace("REJECT_", "")}`;
    else if (interactiveId === "SELECT_ACTION") effectiveInput = "SELECT_ACTION";
    else if (interactiveId === "MAKE_PAYMENT") effectiveInput = "MAKE_PAYMENT";
    else if (interactiveId === "SEND_INTEREST") effectiveInput = "SEND_INTEREST";
    else if (interactiveId === "VIEW_CONTACT") effectiveInput = "VIEW_CONTACT";
    else if (interactiveId === "NEXT") effectiveInput = "NEXT";
    else if (interactiveId === "FILTER_SEARCH") effectiveInput = "FILTER_SEARCH";
    else if (interactiveId === "CLEAR_FILTERS") effectiveInput = "CLEAR_FILTERS";
    else if (interactiveId === "APPLY_FILTERS") effectiveInput = "APPLY_FILTERS";
    else if (interactiveId === "SKIP_FILTERS") effectiveInput = "SKIP_FILTERS";
    else if (interactiveId.startsWith("ADMIN_APPROVE_") || interactiveId.startsWith("ADMIN_REJECT_")) {
      const profileId = normalizeProfileId(interactiveId.replace("ADMIN_APPROVE_", "").replace("ADMIN_REJECT_", ""));
      effectiveInput = interactiveId.startsWith("ADMIN_APPROVE_") ? `APPROVE ${profileId}` : `REJECT ${profileId}`;
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

    // ===================== MAIN MENU =====================
    const isGreetingText = isGreeting(text) && !isButtonClick;
    
    if (isGreetingText && !st.step) {
      await sendText(from, WELCOME_MSG);
      await delay(500);
      await sendJoinSearchStopButtons(from);
      await setState(from, "", {});
      return;
    }
    
    if (!st.step && !cmd && !interactiveId && text && !isGreetingText) {
      await sendText(from, "ℹ️ *Please use the buttons below*\n*कृपया नीचे दिए गए बटन का उपयोग करें*");
      await delay(500);
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== JOIN - Registered users =====================
    if (cmd === "JOIN") {
      const existing = await findProfilesByPhone(from);
      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        const profile = existing[0];
        const status = profile.status === "APPROVED" ? "✅ ACTIVE" : "⏳ PENDING";
        await sendText(from, `ℹ️ *You already have a profile!*\n*आपके पास पहले से प्रोफाइल है!*\n\n🆔 ID: ${profile.profile_id}\n📊 Status: ${status}\n\n📝 You can manage your profile or search for matches.\nआप अपनी प्रोफाइल प्रबंधित कर सकते हैं या रिश्ते खोज सकते हैं।`);
        await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
          { id: "MYPROFILES", title: "📋 MY PROFILES" },
          { id: "SEARCH", title: "🔍 SEARCH" },
        ]);
        return;
      }
      await setState(from, "ASK_NAME", {});
      await sendText(from, "📝 *Let's create your profile!*\n*आइए आपकी प्रोफाइल बनाएं!*\n\nFirst, enter your name / पहले अपना नाम लिखें:");
      return;
    }

    if (cmd === "SEARCH") {
      const profiles = await findProfilesByPhone(from);
      const active = getLatestApprovedProfile(profiles);
      
      if (!active) {
        if (!profiles.length) {
          await sendText(from, "📝 *Please create a profile first*\n*कृपया पहले प्रोफाइल बनाएं*\n\nUse JOIN to register.\nJOIN करके रजिस्टर करें।");
          await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
            { id: "JOIN", title: "📝 JOIN" },
          ]);
          return;
        }
        await sendText(from, "⏳ *Approval Pending*\n*स्वीकृति लंबित*\n\nYour profile is not yet approved. Please wait for admin approval.\nआपकी प्रोफाइल अभी तक स्वीकृत नहीं है। कृपया admin approval का इंतजार करें।");
        return;
      }
      
      const targetGender = active.gender === "male" ? "female" : "male";
      
      // Show filter options or direct search
      temp.searchFilters = temp.searchFilters || {};
      temp.searchFilters.excludeProfileId = active.profile_id;
      temp.searchFilters.targetGender = targetGender;
      temp.userProfile = active;
      
      await setState(from, "SEARCH_FILTER_MENU", temp);
      await sendText(from, FILTER_INTRO_MSG);
      await sendButtons(from, "👇 *Start search or add filters* / *खोज शुरू करें या फ़िल्टर जोड़ें* 👇", [
        { id: "APPLY_FILTERS", title: "🔍 SEARCH NOW" },
        { id: "FILTER_SEARCH", title: "🔧 FILTERS" },
        { id: "STOP", title: "⏹️ STOP" },
      ]);
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

    // ===================== FILTER SEARCH FLOW =====================
    if (effectiveInput === "FILTER_SEARCH") {
      await setState(from, "FILTER_MENU", temp);
      await sendText(from, "🔧 *Select filter type*\n*फ़िल्टर प्रकार चुनें*");
      await sendButtons(from, "👇 *Choose filter* / *फ़िल्टर चुनें* 👇", [
        { id: "FILTER_AGE", title: "🎂 AGE" },
        { id: "FILTER_RELIGION", title: "🕉️ RELIGION" },
        { id: "FILTER_MARITAL", title: "💍 MARITAL" },
      ]);
      return;
    }

    // Filter Menu or sub-states
    if (st.step === "FILTER_MENU" || st.step?.startsWith("FILTER_")) {
      if (effectiveInput === "FILTER_AGE") {
        await setState(from, "FILTER_AGE_MIN", temp);
        await sendText(from, "🎂 *Enter minimum age*\n*न्यूनतम आयु लिखें*\n\nExample: 21");
        return;
      }
      
      if (st.step === "FILTER_AGE_MIN") {
        const minAge = parseInt(text);
        if (isNaN(minAge) || minAge < 18 || minAge > 80) {
          await sendText(from, "❌ Please enter valid age (18-80).\nकृपया मान्य आयु लिखें (18-80)।");
          return;
        }
        temp.searchFilters = temp.searchFilters || {};
        temp.searchFilters.ageMin = minAge;
        await setState(from, "FILTER_AGE_MAX", temp);
        await sendText(from, "🎂 *Enter maximum age*\n*अधिकतम आयु लिखें*\n\nExample: 35");
        return;
      }
      
      if (st.step === "FILTER_AGE_MAX") {
        const maxAge = parseInt(text);
        if (isNaN(maxAge) || maxAge < 18 || maxAge > 80) {
          await sendText(from, "❌ Please enter valid age (18-80).\nकृपया मान्य आयु लिखें (18-80)।");
          return;
        }
        temp.searchFilters = temp.searchFilters || {};
        temp.searchFilters.ageMax = maxAge;
        await sendText(from, `✅ *Age filter: ${temp.searchFilters.ageMin || 18} - ${maxAge}*\n*आयु फ़िल्टर सेट*`);
        await setState(from, "SEARCH_FILTER_MENU", temp);
        await sendButtons(from, "👇 *Continue* / *जारी रखें* 👇", [
          { id: "APPLY_FILTERS", title: "🔍 SEARCH" },
          { id: "FILTER_SEARCH", title: "🔧 MORE FILTERS" },
          { id: "CLEAR_FILTERS", title: "🔄 CLEAR ALL" },
        ]);
        return;
      }
      
      if (effectiveInput === "FILTER_RELIGION") {
        await setState(from, "FILTER_RELIGION_INPUT", temp);
        await sendText(from, "🕉️ *Enter religion*\n*धर्म लिखें*\n\nExample: Hindu, Muslim, Christian");
        return;
      }
      
      if (st.step === "FILTER_RELIGION_INPUT") {
        if (!text || text.length < 2) {
          await sendText(from, "❌ Please enter a valid religion.\nकृपया मान्य धर्म लिखें।");
          return;
        }
        temp.searchFilters = temp.searchFilters || {};
        temp.searchFilters.religion = text;
        await sendText(from, `✅ *Religion filter: ${text}*\n*धर्म फ़िल्टर सेट*`);
        await setState(from, "SEARCH_FILTER_MENU", temp);
        await sendButtons(from, "👇 *Continue* / *जारी रखें* 👇", [
          { id: "APPLY_FILTERS", title: "🔍 SEARCH" },
          { id: "FILTER_SEARCH", title: "🔧 MORE FILTERS" },
          { id: "CLEAR_FILTERS", title: "🔄 CLEAR ALL" },
        ]);
        return;
      }
      
      if (effectiveInput === "FILTER_MARITAL") {
        await setState(from, "FILTER_MARITAL_INPUT", temp);
        await sendList(from, "💍 *Select marital status*\n*वैवाहिक स्थिति चुनें*", "Select", [
          { id: "MARITAL_UNMARRIED", title: "Unmarried / अविवाहित" },
          { id: "MARITAL_DIVORCE", title: "Divorced / तलाकशुदा" },
          { id: "MARITAL_WIDOW", title: "Widowed / विधुर/विधवा" },
          { id: "MARITAL_ANY", title: "Any / कोई भी" },
        ]);
        return;
      }
      
      if (st.step === "FILTER_MARITAL_INPUT") {
        let ms = "";
        if (interactiveId === "MARITAL_UNMARRIED") ms = "Unmarried";
        else if (interactiveId === "MARITAL_DIVORCE") ms = "Divorced";
        else if (interactiveId === "MARITAL_WIDOW") ms = "Widowed";
        else if (interactiveId === "MARITAL_ANY") ms = "ANY";
        if (!ms) { await sendText(from, "❌ Please select.\nकृपया चुनें।"); return; }
        temp.searchFilters = temp.searchFilters || {};
        temp.searchFilters.maritalStatus = ms;
        await sendText(from, `✅ *Marital filter: ${ms}*\n*वैवाहिक फ़िल्टर सेट*`);
        await setState(from, "SEARCH_FILTER_MENU", temp);
        await sendButtons(from, "👇 *Continue* / *जारी रखें* 👇", [
          { id: "APPLY_FILTERS", title: "🔍 SEARCH" },
          { id: "FILTER_SEARCH", title: "🔧 MORE FILTERS" },
          { id: "CLEAR_FILTERS", title: "🔄 CLEAR ALL" },
        ]);
        return;
      }
      
      // Default for any unrecognized filter state
      if (st.step?.startsWith("FILTER_")) {
        await setState(from, "SEARCH_FILTER_MENU", temp);
        await sendButtons(from, "👇 *Continue* / *जारी रखें* 👇", [
          { id: "APPLY_FILTERS", title: "🔍 SEARCH" },
          { id: "FILTER_SEARCH", title: "🔧 MORE FILTERS" },
        ]);
        return;
      }
    }

    // ===================== APPLY FILTERS & SEARCH =====================
    if (effectiveInput === "APPLY_FILTERS") {
      const filters = temp.searchFilters || {};
      const userProfile = temp.userProfile;
      
      await sendText(from, SEARCHING_MSG);
      
      try {
        const allProfiles = [];
        const rows = await getAllProfilesRows();
        for (let i = 1; i < rows.length; i++) {
          if (rows[i] && rows[i].length > 5) {
            allProfiles.push(profileRowToObj(rows[i], i + 1));
          }
        }
        
        const results = applyFilters(allProfiles, filters, userProfile);
        
        if (results.length === 0) {
          await sendText(from, NO_MATCHES_MSG);
          await sendButtons(from, "👇 *What would you like to do?*\n*आप क्या करना चाहेंगे?*", [
            { id: "FILTER_SEARCH", title: "🔧 CHANGE FILTERS" },
            { id: "SEARCH", title: "🔄 NEW SEARCH" },
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
        console.error("Search error:", err);
        await sendText(from, "❌ *Something went wrong*\n*कुछ गड़बड़ हुई*\n\nPlease try again.\nकृपया पुनः प्रयास करें।");
        await setState(from, "", {});
        await sendJoinSearchStopButtons(from);
      }
      return;
    }

    if (effectiveInput === "CLEAR_FILTERS") {
      temp.searchFilters = {
        excludeProfileId: temp.userProfile?.profile_id || "",
        targetGender: temp.userProfile?.gender === "male" ? "female" : "male",
      };
      await setState(from, "SEARCH_FILTER_MENU", temp);
      await sendText(from, "🔄 *All filters cleared*\n*सभी फ़िल्टर हटा दिए गए*\n\nStarting fresh search...");
      await sendButtons(from, "👇 *Continue* / *जारी रखें* 👇", [
        { id: "APPLY_FILTERS", title: "🔍 SEARCH NOW" },
        { id: "FILTER_SEARCH", title: "🔧 ADD FILTERS" },
      ]);
      return;
    }

    // ===================== SELECT ACTION =====================
    if (effectiveInput === "SELECT_ACTION") {
      if (!temp.currentViewingProfile) {
        await sendText(from, "ℹ️ *No profile selected*\n*कोई प्रोफाइल चुनी नहीं गई*\n\nStarting new search...");
        await handleDirectCommand(from, "SEARCH", [], temp, st);
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
      
      const active = getLatestApprovedProfile(userProfiles);
      if (!active) {
        await sendText(from, "⏳ *Please wait for profile approval*\n*कृपया प्रोफाइल स्वीकृति का इंतजार करें*");
        await sendButtons(from, "👇 *Choose option* / *एक विकल्प चुनें* 👇", [
          { id: "NEXT", title: "⏩ NEXT" },
          { id: "SEARCH", title: "🔍 SEARCH" },
        ]);
        return;
      }
      
      await sendButtons(from, `💖 *Actions for ${temp.currentViewingProfile.profile_id}*`, [
        { id: "SEND_INTEREST", title: "💌 SEND INTEREST" },
        { id: "NEXT", title: "⏩ NEXT" },
      ]);
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
      const target = temp.currentViewingProfile;
      await sendText(from, `📞 *Contact Details / संपर्क विवरण*\n\n👤 Name: ${target.name || "NA"} ${target.surname || "NA"}\n🆔 Profile: ${target.profile_id}\n📱 Phone: ${target.phone}\n\n💝 *Best wishes from Vivaho!*\n*Vivaho की ओर से शुभकामनाएं!*`);
      return;
    }

    // ===================== ADMIN APPROVE/REJECT =====================
    if (cmd === "APPROVE" || cmd === "REJECT") {
      if (!isAdmin(from)) { await sendText(from, "❌ *Admin access only*\n*केवल एडमिन की पहुंच*"); return; }
      
      const profileId = normalizeProfileId(args[0]);
      const prof = await findProfileById(profileId);
      if (!prof) { await sendText(from, "❌ Profile not found."); return; }
      
      const newStatus = cmd === "APPROVE" ? "APPROVED" : "REJECTED";
      await updateProfileStatus(prof.rowIndex, newStatus);
      
      if (newStatus === "APPROVED") {
        await sendText(prof.phone, `🎉 *Profile Approved!*\n*प्रोफाइल स्वीकृत!* 🎉\n\nYour profile ${profileId} is now active.\nआपकी प्रोफाइल ${profileId} अब सक्रिय है।\n\nStart searching for matches!\nरिश्ते खोजना शुरू करें!`);
        await sendButtons(prof.phone, "👇 *Start now* / *अभी शुरू करें* 👇", [
          { id: "SEARCH", title: "🔍 SEARCH" },
        ]);
      } else {
        await sendText(prof.phone, `❌ *Profile Rejected*\n*प्रोफाइल अस्वीकृत*\n\nYour profile ${profileId} was rejected.\nआपकी प्रोफाइल ${profileId} अस्वीकृत कर दी गई।\n\nPlease create a new one.\nकृपया नई प्रोफाइल बनाएं।`);
      }
      await sendText(from, `✅ ${newStatus} ${profileId}`);
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
        
        await sendText(from, `🎉 *Registration Complete!*\n*पंजीकरण पूर्ण!* 🎉\n\n🆔 *Your Profile ID:* *${profileId}*\n\n✨ Congratulations! Your profile has been created.\nबधाई हो! आपकी प्रोफाइल बन गई है।\n\n⏳ Waiting for admin approval.\nAdmin approval का इंतजार है।`);
        
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
  console.log(`⚡ Rate Limiting: ${MIN_MESSAGE_GAP}ms gap, ${MAX_MESSAGES_PER_MINUTE} msg/min`);
});
