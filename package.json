// index.js — Vivaho WhatsApp Matrimony Bot (Final Fixed Version)
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
const UPI_ID = process.env.UPI_ID || "";
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

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

// Messages
const WELCOME_MSG = `💍 *${BRAND_NAME}*
${BRAND_TAGLINE}

Type *JOIN* to create profile
Type *SEARCH* to find matches
Type *STOP* to cancel`;

const NO_MATCHES_MSG = `😔 No matches found.
Try different preferences or check back later.`;

// Global search cache (in memory, not in sheet)
global.searchCache = new Map();

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

// ===================== WhatsApp API =====================
async function sendText(to, body) {
  const phone = normalizePhone(to);
  if (!phone) return;
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      { messaging_product: "whatsapp", to: phone, type: "text", text: { body: trimTo(body, 4096) } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
  } catch (err) {
    console.error("sendText failed:", err?.response?.data || err.message);
  }
}

async function sendImageByLink(to, imageLink, caption = "") {
  const phone = normalizePhone(to);
  if (!phone) return;
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to: phone, type: "image", image: { link: imageLink, ...(caption ? { caption: trimTo(caption, 4096) } : {}) } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
  );
}

async function sendButtons(to, body, buttons) {
  const phone = normalizePhone(to);
  if (!phone || !buttons || buttons.length === 0 || buttons.length > 3) return;
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
        action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) } })) }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
  );
}

async function sendList(to, body, buttonText, rows, sectionTitle = "Select") {
  const phone = normalizePhone(to);
  if (!phone || !rows || !rows.length) return;
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
          sections: [{ title: trimTo(sectionTitle, 24), rows: rows.map((r) => ({ id: String(r.id).slice(0, 256), title: String(r.title).slice(0, 24) })) }]
        }
      }
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, timeout: 20000 }
  );
}

async function sendJoinSearchStopButtons(to) {
  await sendButtons(to, "Choose an option:", [
    { id: "JOIN", title: "JOIN" },
    { id: "SEARCH", title: "SEARCH" },
    { id: "STOP", title: "STOP" },
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
  await sendText(ADMIN_PHONE, `🆕 New Profile\nID: ${profileId}\nPhone: ${phone}\nName: ${temp.name || ""} ${temp.surname || ""}`);
}

async function notifyAdminPayment(userPhone, profileId, planType) {
  if (!ADMIN_PHONE) return;
  let planMsg = "", buttons = [];
  if (planType === "PLAN_1_3MO") {
    planMsg = "₹300 for 3 months";
    buttons = [{ id: `ADMIN_APPROVE_1_3MO_${profileId}_${userPhone}`, title: "APPROVE 1" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  } else if (planType === "PLAN_1_YEAR") {
    planMsg = "₹1000 for 1 year";
    buttons = [{ id: `ADMIN_APPROVE_1_YEAR_${profileId}_${userPhone}`, title: "APPROVE 1" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  } else if (planType === "PLAN_2_YEAR") {
    planMsg = "₹2000 for 1 year";
    buttons = [{ id: `ADMIN_APPROVE_2_YEAR_${profileId}_${userPhone}`, title: "APPROVE 2" }, { id: `ADMIN_REJECT_${profileId}_${userPhone}`, title: "REJECT" }];
  }
  await sendText(ADMIN_PHONE, `💰 Payment Received\nUser: ${userPhone}\nProfile: ${profileId}\n${planMsg}`);
  await sendButtons(ADMIN_PHONE, `Action for ${profileId}`, buttons);
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

async function showProfileCard(to, profile, temp) {
  const age = calcAgeFromDobDDMMYYYY(profile.date_of_birth);
  const msg = `📷 *Profile ${profile.profile_id}*
Age: ${age || "NA"} | Height: ${profile.height || "NA"}
Religion: ${profile.religion || "NA"} | Caste: ${profile.caste || "NA"}
Education: ${profile.education || "NA"}
Job: ${profile.job_title || profile.job || "NA"}
Native: ${profile.native_place || "NA"} | Work: ${profile.work_city || "NA"}`;
  
  if (profile.photo_url) {
    await sendImageByLink(to, profile.photo_url, msg);
  } else {
    await sendText(to, msg);
  }
  temp.currentViewingProfile = profile;
  await setState(to, "SEARCH_RESULTS_VIEW", temp);
  await sendButtons(to, "Choose action:", [
    { id: "SELECT_ACTION", title: "SELECT" },
    { id: "NEXT", title: "NEXT" },
  ]);
}

async function sendPaymentRequiredMessage(to) {
  await sendText(to, "❌ Please make payment to send interest and view contact details.\n\n💰 Plans:\n• ₹300 for 3 months (Interest only)\n• ₹1000 for 1 year (Interest only)\n• ₹2000 for 1 year (Interest + Contact)");
  await sendButtons(to, "Choose option:", [
    { id: "JOIN", title: "JOIN" },
    { id: "SEARCH", title: "SEARCH" },
  ]);
}

// ===================== handleDirectCommand =====================
async function handleDirectCommand(from, cmd, args, temp, st) {
  if (cmd === "MYPROFILES") {
    const profiles = await findProfilesByPhone(from);
    if (!profiles.length) {
      await sendText(from, WELCOME_MSG);
      await sendJoinSearchStopButtons(from);
      return;
    }
    let msg = "Your profiles:\n";
    for (const p of profiles) {
      msg += `• ${p.profile_id} (${p.approved_1 === "APPROVED" ? "ACTIVE" : "PENDING"})\n`;
    }
    await sendText(from, msg);
    await sendButtons(from, "Select profile:", profiles.slice(0, 5).map(p => ({ id: `MYPROFILE_${p.profile_id}`, title: p.profile_id })));
    return;
  }

  if (cmd === "DELETE") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "Use: DELETE MH-XXXX"); return; }
    const prof = await findProfileById(profileId);
    if (!prof) { await sendText(from, "Profile not found."); return; }
    if (prof.phone !== from) { await sendText(from, "You can only delete your own profile."); return; }
    await deleteProfileRow(prof.rowIndex);
    await setState(from, "", {});
    await sendText(from, `✅ Deleted ${profileId}`);
    await sendJoinSearchStopButtons(from);
    return;
  }

  if (cmd === "SEARCH") {
    await sendText(from, "🔍 Select Bride or Groom:");
    await setState(from, "SEARCH_BRIDE_GROOM", {});
    await sendButtons(from, "Select:", [
      { id: "SEARCH_BRIDE", title: "BRIDE" },
      { id: "SEARCH_GROOM", title: "GROOM" },
      { id: "STOP", title: "STOP" },
    ]);
    return;
  }

  if (cmd === "NEXT") {
    const cacheId = temp.searchCacheId;
    const cache = global.searchCache?.get(cacheId);
    
    if (!cache || !cache.results || !cache.results.length) {
      await sendText(from, "No active search. Type SEARCH to start.");
      return;
    }
    
    let newIndex = cache.index + 1;
    if (newIndex >= cache.results.length) newIndex = 0;
    cache.index = newIndex;
    global.searchCache.set(cacheId, cache);
    
    temp.searchCacheId = cacheId;
    await setState(from, "SEARCH_RESULTS_VIEW", temp);
    
    const profile = cache.results[newIndex];
    const age = calcAgeFromDobDDMMYYYY(profile.date_of_birth);
    const msg = `📷 *Profile ${profile.profile_id}*
Age: ${age || "NA"} | Height: ${profile.height || "NA"}
Religion: ${profile.religion || "NA"} | Caste: ${profile.caste || "NA"}
Education: ${profile.education || "NA"}
Job: ${profile.job_title || profile.job || "NA"}
Native: ${profile.native_place || "NA"} | Work: ${profile.work_city || "NA"}`;
    
    if (profile.photo_url) {
      await sendImageByLink(from, profile.photo_url, msg);
    } else {
      await sendText(from, msg);
    }
    
    temp.currentViewingProfile = profile;
    await setState(from, "SEARCH_RESULTS_VIEW", temp);
    return;
  }

  if (cmd === "DETAILS") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "Use: DETAILS MH-XXXX"); return; }
    const target = await findProfileById(profileId);
    if (!target) { await sendText(from, "Profile not found."); return; }
    const age = calcAgeFromDobDDMMYYYY(target.date_of_birth);
    const msg = `Profile: ${target.profile_id}\nGender: ${target.gender}\nAge: ${age || "NA"}\nNative: ${target.native_place || "NA"}\nWork: ${target.work_city || "NA"}\nEducation: ${target.education || "NA"}\nJob: ${target.job_title || target.job || "NA"}\nMarital Status: ${target.marital_status || "NA"}`;
    if (target.photo_url) {
      await sendImageByLink(from, target.photo_url, msg);
    } else {
      await sendText(from, msg);
    }
    return;
  }

  if (cmd === "INTEREST") {
    const profileId = normalizeProfileId(args[0]);
    if (!profileId) { await sendText(from, "Use: INTEREST MH-XXXX"); return; }
    const userProfiles = await findProfilesByPhone(from);
    if (!userProfiles.length) { await sendPaymentRequiredMessage(from); return; }
    const userProfile = userProfiles[0];
    const { canSendInterest } = getUserPaymentStatus(userProfile);
    if (!canSendInterest) { await sendPaymentRequiredMessage(from); return; }
    if (userProfile.profile_id === profileId) { await sendText(from, "Cannot send interest to yourself."); return; }
    const target = await findProfileById(profileId);
    if (!target) { await sendText(from, "Profile not found."); return; }
    const existing = await findInterestRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id });
    if (existing && existing.status === "SENT") { await sendText(from, "Interest already sent."); return; }
    await appendRequest({ from_profile_id: userProfile.profile_id, to_profile_id: target.profile_id, status: "SENT", type: "INTEREST", viewer_phone: from });
    await sendButtons(target.phone, `Interest from ${userProfile.profile_id}`, [
      { id: `ACCEPT_${userProfile.profile_id}`, title: "ACCEPT" },
      { id: `REJECT_${userProfile.profile_id}`, title: "REJECT" },
    ]);
    await sendText(from, `✅ Interest sent to ${profileId}`);
    return;
  }

  if (cmd === "ACCEPT" || cmd === "REJECT") {
    const interestedProfileId = normalizeProfileId(args[0]);
    if (!interestedProfileId) { await sendText(from, "Use: ACCEPT MH-XXXX or REJECT MH-XXXX"); return; }
    const receiverProfiles = await findProfilesByPhone(from);
    if (!receiverProfiles.length) { await sendText(from, "No profile found."); return; }
    const receiverActive = receiverProfiles[0];
    const existing = await findInterestRequest({ from_profile_id: interestedProfileId, to_profile_id: receiverActive.profile_id });
    if (!existing || existing.status !== "SENT") { await sendText(from, "No pending interest."); return; }
    const senderProfile = await findProfileById(interestedProfileId);
    if (cmd === "REJECT") {
      await sendText(from, `Rejected interest from ${interestedProfileId}`);
      if (senderProfile) await sendText(senderProfile.phone, `Your interest was rejected by ${receiverActive.profile_id}`);
      return;
    }
    await sendText(from, `Accepted interest from ${interestedProfileId}`);
    const { canViewContact } = getUserPaymentStatus(receiverActive);
    if (canViewContact && senderProfile) {
      await sendText(from, `Contact: ${interestedProfileId} - ${senderProfile.phone}`);
      await sendText(senderProfile.phone, `Contact shared: ${receiverActive.profile_id} - ${receiverActive.phone}`);
    } else {
      await sendText(senderProfile.phone, `Your interest was accepted! The user will contact you.`);
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
    const msgType = msg.type;
    const text = (msg.text?.body || "").trim();
    const interactiveId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || "";
    const st = await getState(from);
    const temp = safeJsonParse(st.temp_data || "{}", {});
    let effectiveInput = text || interactiveId || "";

    // Clean old search cache (run every hour)
    if (Math.random() < 0.01) { // 1% chance on each request
      for (const [key, val] of global.searchCache.entries()) {
        if (Date.now() - val.timestamp > 60 * 60 * 1000) { // 1 hour
          global.searchCache.delete(key);
        }
      }
    }

    // Handle button commands
    if (interactiveId.startsWith("ACCEPT_")) effectiveInput = `ACCEPT ${interactiveId.replace("ACCEPT_", "")}`;
    else if (interactiveId.startsWith("REJECT_")) effectiveInput = `REJECT ${interactiveId.replace("REJECT_", "")}`;
    else if (interactiveId === "SELECT_ACTION") effectiveInput = "SELECT_ACTION";
    else if (interactiveId === "SEARCH_BRIDE" || interactiveId === "SEARCH_GROOM") effectiveInput = interactiveId;
    else if (interactiveId === "MAKE_PAYMENT") effectiveInput = "MAKE_PAYMENT";
    else if (interactiveId === "SEND_INTEREST") effectiveInput = "SEND_INTEREST";
    else if (interactiveId === "VIEW_CONTACT") effectiveInput = "VIEW_CONTACT";
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
        await sendButtons(from, `Profile: ${profileId}`, [
          { id: `DETAILS_${profileId}`, title: "DETAILS" },
          { id: `SELF_DELETE_${profileId}`, title: "DELETE" },
        ]);
      }
      return;
    } else if (interactiveId.startsWith("SELF_DELETE_")) {
      effectiveInput = `DELETE ${interactiveId.replace("SELF_DELETE_", "")}`;
    }

    const { cmd, args } = parseCommand(effectiveInput);

    // Welcome message for first time
    if (!st.step || cmd === "VIVAHO_HOME") {
      await sendText(from, WELCOME_MSG);
      await sendJoinSearchStopButtons(from);
      await setState(from, "", {});
      return;
    }

    // Handle direct commands
    if (cmd === "JOIN") {
      const existing = await findProfilesByPhone(from);
      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        await sendText(from, `You already have ${existing.length} profile (max ${MAX_PROFILES_PER_PHONE})`);
        return;
      }
      await setState(from, "ASK_NAME", {});
      await sendText(from, "Enter your name:");
      return;
    }

    if (cmd === "SEARCH") {
      await handleDirectCommand(from, "SEARCH", [], temp, st);
      return;
    }

    if (cmd === "STOP") {
      await setState(from, "", {});
      await sendText(from, "Process stopped.");
      await sendJoinSearchStopButtons(from);
      return;
    }

    // ===================== SEARCH BRIDE/GROOM SELECTION (FIXED - USES CACHE) =====================
    if (effectiveInput === "SEARCH_BRIDE" || effectiveInput === "SEARCH_GROOM") {
      await sendText(from, "🔍 Searching for matches... ⏳");
      
      try {
        const targetGender = effectiveInput === "SEARCH_BRIDE" ? "female" : "male";
        
        const allVisible = await getAllVisibleProfiles();
        
        if (allVisible.length === 0) {
          await sendText(from, "❌ No profiles found in database.");
          return;
        }
        
        const results = [];
        for (const p of allVisible) {
          if (p.gender === targetGender) {
            results.push(p);
          }
        }
        
        if (results.length === 0) {
          await sendText(from, `❌ No ${targetGender} profiles found. Try the other option.`);
          return;
        }
        
        // Store in memory cache (not in sheet)
        const cacheId = `${from}_${Date.now()}`;
        global.searchCache.set(cacheId, { results, index: 0, timestamp: Date.now() });
        
        temp.searchCacheId = cacheId;
        await setState(from, "SEARCH_RESULTS_VIEW", temp);
        
        const profile = results[0];
        const age = calcAgeFromDobDDMMYYYY(profile.date_of_birth);
        const msg = `📷 *Profile ${profile.profile_id}*
Age: ${age || "NA"} | Height: ${profile.height || "NA"}
Religion: ${profile.religion || "NA"} | Caste: ${profile.caste || "NA"}
Education: ${profile.education || "NA"}
Job: ${profile.job_title || profile.job || "NA"}
Native: ${profile.native_place || "NA"} | Work: ${profile.work_city || "NA"}`;
        
        if (profile.photo_url) {
          await sendImageByLink(from, profile.photo_url, msg);
        } else {
          await sendText(from, msg);
        }
        
        temp.currentViewingProfile = profile;
        await setState(from, "SEARCH_RESULTS_VIEW", temp);
        
        await sendButtons(from, "Choose action:", [
          { id: "SELECT_ACTION", title: "SELECT" },
          { id: "NEXT", title: "NEXT" },
        ]);
        
      } catch (err) {
        await sendText(from, `❌ ERROR: ${err.message || err.toString()}`);
        console.error("Search error:", err);
      }
      return;
    }

    // SELECT action buttons
    if (effectiveInput === "SELECT_ACTION") {
      if (!temp.currentViewingProfile) {
        await sendText(from, "No profile selected. Start a new search.");
        return;
      }
      await sendButtons(from, `Actions for ${temp.currentViewingProfile.profile_id}:`, [
        { id: "SEND_INTEREST", title: "SEND INTEREST" },
        { id: "VIEW_CONTACT", title: "VIEW CONTACT" },
      ]);
      return;
    }

    if (effectiveInput === "SEND_INTEREST") {
      if (!temp.currentViewingProfile) return;
      await handleDirectCommand(from, "INTEREST", [temp.currentViewingProfile.profile_id], temp, st);
      return;
    }

    if (effectiveInput === "VIEW_CONTACT") {
      if (!temp.currentViewingProfile) return;
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) { await sendPaymentRequiredMessage(from); return; }
      const { canViewContact } = getUserPaymentStatus(userProfiles[0]);
      if (!canViewContact) { await sendPaymentRequiredMessage(from); return; }
      await sendText(from, `📞 Contact: ${temp.currentViewingProfile.phone}`);
      return;
    }

    // Payment flow
    if (effectiveInput === "MAKE_PAYMENT") {
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) {
        await sendText(from, "Create profile first using JOIN");
        return;
      }
      await setState(from, "PAYMENT_SELECT_PLAN", temp);
      await sendButtons(from, "Choose plan:", [
        { id: "PLAN_1_3MO", title: "₹300 (3mo)" },
        { id: "PLAN_1_YEAR", title: "₹1000 (1yr)" },
        { id: "PLAN_2_YEAR", title: "₹2000 (1yr)" },
      ]);
      return;
    }

    if (effectiveInput === "PLAN_1_3MO" || effectiveInput === "PLAN_1_YEAR" || effectiveInput === "PLAN_2_YEAR") {
      temp.selectedPlan = effectiveInput;
      await setState(from, "PAYMENT_QR", temp);
      let amount = effectiveInput === "PLAN_1_3MO" ? "₹300" : (effectiveInput === "PLAN_1_YEAR" ? "₹1000" : "₹2000");
      await sendText(from, `💰 Amount: ${amount}\nUPI: ${UPI_ID}`);
      if (QR_IMAGE_URL) await sendImageByLink(from, QR_IMAGE_URL, "Scan to Pay");
      await sendButtons(from, "After payment:", [
        { id: "PAYMENT_DONE", title: "I HAVE PAID" },
        { id: "CANCEL", title: "CANCEL" },
      ]);
      return;
    }

    if (effectiveInput === "PAYMENT_DONE") {
      const userProfiles = await findProfilesByPhone(from);
      if (!userProfiles.length) return;
      await notifyAdminPayment(from, userProfiles[0].profile_id, temp.selectedPlan || "PLAN_1_YEAR");
      await sendText(from, "✅ Payment notification sent. You will be approved shortly.");
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from);
      return;
    }

    if (effectiveInput === "CANCEL") {
      await setState(from, "", {});
      await sendJoinSearchStopButtons(from);
      return;
    }

    // Admin approval commands
    if (cmd === "ADMIN_APPROVE_1_3MO" || cmd === "ADMIN_APPROVE_1_YEAR" || cmd === "ADMIN_APPROVE_2_YEAR" || cmd === "ADMIN_REJECT") {
      if (!isAdmin(from)) { await sendText(from, "Only admin can approve."); return; }
      const profileId = args[0];
      const userPhone = args[1];
      const prof = await findProfileById(profileId);
      if (!prof) { await sendText(from, "Profile not found."); return; }
      if (cmd === "ADMIN_REJECT") {
        await sendText(userPhone, "❌ Payment verification failed. Please contact admin.");
        await sendText(from, "Rejected");
        return;
      }
      if (cmd === "ADMIN_APPROVE_1_3MO") {
        await updateProfileApproval1(prof.rowIndex, "APPROVED", addMonths(nowISO(), 3));
        await sendText(userPhone, "✅ Payment verified! You can now send interest. (₹300 - 3 months)");
      } else if (cmd === "ADMIN_APPROVE_1_YEAR") {
        await updateProfileApproval1(prof.rowIndex, "APPROVED", addYears(nowISO(), 1));
        await sendText(userPhone, "✅ Payment verified! You can now send interest. (₹1000 - 1 year)");
      } else if (cmd === "ADMIN_APPROVE_2_YEAR") {
        await updateProfileApproval1(prof.rowIndex, "APPROVED", addYears(nowISO(), 1));
        await updateProfileApproval2(prof.rowIndex, "APPROVED", addYears(nowISO(), 1));
        await sendText(userPhone, "✅ Payment verified! You can now send interest and view contacts. (₹2000 - 1 year)");
      }
      await sendText(from, `Approved ${profileId}`);
      return;
    }

    if (cmd === "NEXT") {
      await handleDirectCommand(from, "NEXT", [], temp, st);
      return;
    }

    if (cmd === "MYPROFILES") {
      await handleDirectCommand(from, "MYPROFILES", [], temp, st);
      return;
    }

    if (cmd === "DELETE") {
      await handleDirectCommand(from, "DELETE", args, temp, st);
      return;
    }

    // Registration flow
    if (st.step === "ASK_NAME") {
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, "Enter your surname:");
      return;
    }
    if (st.step === "ASK_SURNAME") {
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendButtons(from, "Select gender:", [
        { id: "GENDER_MALE", title: "MALE" },
        { id: "GENDER_FEMALE", title: "FEMALE" },
      ]);
      return;
    }
    if (st.step === "ASK_GENDER") {
      let g = interactiveId === "GENDER_MALE" ? "male" : (interactiveId === "GENDER_FEMALE" ? "female" : normalizeGender(text));
      if (!g) { await sendText(from, "Please select gender."); return; }
      temp.gender = g;
      await setState(from, "ASK_MARITAL_STATUS", temp);
      await sendList(from, "Marital status:", "Select", [
        { id: "MARITAL_UNMARRIED", title: "Unmarried" },
        { id: "MARITAL_DIVORCE", title: "Divorce" },
        { id: "MARITAL_WIDOW", title: "Widower/Widow" },
      ]);
      return;
    }
    if (st.step === "ASK_MARITAL_STATUS") {
      let ms = "";
      if (interactiveId === "MARITAL_UNMARRIED") ms = "Unmarried";
      else if (interactiveId === "MARITAL_DIVORCE") ms = "Divorce";
      else if (interactiveId === "MARITAL_WIDOW") ms = "Widower/Widow";
      if (!ms) { await sendText(from, "Please select marital status."); return; }
      temp.marital_status = ms;
      await setState(from, "ASK_DOB", temp);
      await sendText(from, "Enter DOB (DD-MM-YYYY):");
      return;
    }
    if (st.step === "ASK_DOB") {
      const age = calcAgeFromDobDDMMYYYY(text);
      if (age === null || age < MIN_AGE) { await sendText(from, `Invalid DOB or under ${MIN_AGE}.`); return; }
      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, "Enter height (e.g., 5'6\"):");
      return;
    }
    if (st.step === "ASK_HEIGHT") {
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, "Enter religion:");
      return;
    }
    if (st.step === "ASK_RELIGION") {
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, "Enter caste:");
      return;
    }
    if (st.step === "ASK_CASTE") {
      temp.caste = text;
      await setState(from, "ASK_NATIVE_PLACE", temp);
      await sendText(from, "Enter native place:");
      return;
    }
    if (st.step === "ASK_NATIVE_PLACE") {
      temp.native_place = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, "Enter district:");
      return;
    }
    if (st.step === "ASK_DISTRICT") {
      temp.district = text;
      await setState(from, "ASK_WORK_CITY", temp);
      await sendText(from, "Enter work city (or SAME):");
      return;
    }
    if (st.step === "ASK_WORK_CITY") {
      temp.work_city = isSame(text) ? temp.native_place : text;
      await setState(from, "ASK_WORK_DISTRICT", temp);
      await sendText(from, "Enter work district (or SAME/SKIP):");
      return;
    }
    if (st.step === "ASK_WORK_DISTRICT") {
      temp.work_district = isSkip(text) ? "" : (isSame(text) ? temp.district : text);
      await setState(from, "ASK_EDU", temp);
      await sendText(from, "Enter education:");
      return;
    }
    if (st.step === "ASK_EDU") {
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendButtons(from, "Job type:", [
        { id: "JOB_GOVT", title: "GOVERNMENT" },
        { id: "JOB_PRIVATE", title: "PRIVATE" },
        { id: "JOB_BUSINESS", title: "BUSINESS" },
      ]);
      return;
    }
    if (st.step === "ASK_JOB") {
      let job = "";
      if (interactiveId === "JOB_GOVT") job = "Government";
      else if (interactiveId === "JOB_PRIVATE") job = "Private";
      else if (interactiveId === "JOB_BUSINESS") job = "Business";
      if (!job) { await sendText(from, "Please select job type."); return; }
      temp.job = job;
      await setState(from, "ASK_JOB_TITLE", temp);
      await sendText(from, "Enter job title:");
      return;
    }
    if (st.step === "ASK_JOB_TITLE") {
      temp.job_title = text;
      await setState(from, "ASK_INCOME", temp);
      await sendList(from, "Monthly income:", "Select", [
        { id: "INC_1", title: "Up to 50,000" },
        { id: "INC_2", title: "50K - 1L" },
        { id: "INC_3", title: "1L - 3L" },
        { id: "INC_4", title: "Above 3L" },
      ]);
      return;
    }
    if (st.step === "ASK_INCOME") {
      let income = "";
      if (interactiveId === "INC_1") income = "Up to 50,000";
      else if (interactiveId === "INC_2") income = "50,000 to 1,00,000";
      else if (interactiveId === "INC_3") income = "1,00,000 to 3,00,000";
      else if (interactiveId === "INC_4") income = "Above 3,00,000";
      if (!income) { await sendText(from, "Please select income."); return; }
      temp.income_annual = income;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, "Send your photo 📸");
      return;
    }
    if (st.step === "ASK_PHOTO") {
      if (msgType !== "image") { await sendText(from, "Please send a photo."); return; }
      const mediaId = msg.image?.id;
      if (!mediaId) { await sendText(from, "Photo not received. Try again."); return; }
      const metaUrl = await getMetaMediaUrl(mediaId);
      if (!metaUrl) { await sendText(from, "Could not read photo."); return; }
      const { bytes } = await downloadMetaMediaBytes(metaUrl);
      const photoUrl = await uploadPhotoToCloudinary(bytes, `MH_${from}_${Date.now()}.jpg`);
      if (!photoUrl) { await sendText(from, "Upload failed. Try again."); return; }
      temp.photo_url = photoUrl;
      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);
      await setState(from, "", {});
      await sendText(from, `✅ Registration complete! Your ID: ${profileId}\n\nMake payment to activate features.`);
      await sendButtons(from, "Choose option:", [
        { id: "MAKE_PAYMENT", title: "MAKE PAYMENT" },
        { id: "SEARCH", title: "SEARCH" },
      ]);
      return;
    }

    // Default response
    await sendJoinSearchStopButtons(from);
  } catch (err) {
    console.error("Webhook error:", err?.message || err);
  }
});

// ===================== Start Server =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ ${BRAND_NAME} bot running on port ${PORT}`));
