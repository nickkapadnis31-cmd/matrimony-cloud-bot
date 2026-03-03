// index.js (Meta WhatsApp Cloud API + Google Sheets + Admin Approval)
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");

const app = express();
app.use(express.json());

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const SHEET_ID = process.env.GOOGLE_SHEET_ID || "";
const ADMIN_PHONE = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");

// Optional: store photos permanently in Drive
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";

// ===================== Utils =====================
function normalizePhone(p) {
  return (p || "").toString().replace(/\D/g, "");
}

function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

function isValidDOB(dob) {
  // very light validation DD-MM-YYYY
  return /^\d{2}-\d{2}-\d{4}$/.test(dob);
}

function nowISO() {
  return new Date().toISOString();
}

// ===================== Google Clients =====================
function getAuth() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON in env");
  }
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  // If you use Drive upload feature, keep drive scopes.
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
async function sendText(to, text) {
  const phone = normalizePhone(to);
  if (!phone) return;

  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: text },
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

async function getMetaMediaUrl(mediaId) {
  // Step 1: fetch media object to get temporary URL
  const r = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    timeout: 20000,
  });
  return r.data?.url || "";
}

async function downloadMetaMediaBytes(mediaUrl) {
  // Step 2: download actual bytes (Meta requires token header)
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

async function uploadToDriveAndGetLink(bytes, contentType, filename) {
  if (!GOOGLE_DRIVE_FOLDER_ID) return "";

  const drive = await getDriveClient();

  // Create file
  const createRes = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [GOOGLE_DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: contentType,
      body: Buffer.from(bytes),
    },
    fields: "id, webViewLink",
  });

  const fileId = createRes.data?.id;
  if (!fileId) return "";

  // Make it public (anyone with link can view)
  await drive.permissions.create({
    fileId,
    requestBody: { role: "reader", type: "anyone" },
  });

  // Fetch link
  const fileRes = await drive.files.get({
    fileId,
    fields: "webViewLink",
  });

  return fileRes.data?.webViewLink || "";
}

// ===================== Google Sheet Helpers =====================
// Tabs:
// profiles (A:Q): profile_id, phone, name, surname, gender, date_of_birth, religion, height, caste, city, district, education, job, income_annual, photo_url, status, created_at
// state (A:D): phone, step, temp_data, updated_at
// requests (A:E): req_id, from_profile_id, to_profile_id, status, created_at

async function getState(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "state!A:D",
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
  const updatedAt = nowISO();
  const temp_data = JSON.stringify(tempObj || {});

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "state!A:D",
  });

  const rows = res.data.values || [];
  let rowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone) {
      rowIndex = i + 1; // 1-based
      break;
    }
  }

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "state!A:D",
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp_data, updatedAt]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `state!A${rowIndex}:D${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp_data, updatedAt]] },
    });
  }
}

async function findProfileByPhone(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:Q",
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowPhone = row[1] || "";
    if (rowPhone === phone) {
      return {
        rowIndex: i + 1,
        profile_id: row[0] || "",
        status: row[15] || "", // P column in sheet terms, index 15 in array
      };
    }
  }
  return null;
}

async function findProfileById(profileId) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:Q",
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "").trim() === profileId.trim()) {
      return { rows, row: rows[i], rowIndex: i + 1 };
    }
  }
  return null;
}

async function updateProfileStatus(rowIndex, newStatus) {
  const sheets = await getSheetsClient();
  // Status column = P (16th column) => profiles!P{rowIndex}
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `profiles!P${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: { values: [[newStatus]] },
  });
}

async function generateUniqueProfileId() {
  // quick uniqueness check
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:A",
  });

  const existing = new Set((res.data.values || []).flat().map(String));
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `MH-${Math.floor(1000 + Math.random() * 9000)}`;
    if (!existing.has(id)) return id;
  }
  return `MH-${Date.now().toString().slice(-4)}`;
}

async function createProfile(phone, temp) {
  const sheets = await getSheetsClient();
  const createdAt = nowISO();
  const profile_id = await generateUniqueProfileId();

  const row = [
    profile_id,                 // A
    phone,                      // B
    temp.name || "",            // C
    temp.surname || "",         // D
    temp.gender || "",          // E
    temp.date_of_birth || "",   // F
    temp.religion || "",        // G
    temp.height || "",          // H
    temp.caste || "",           // I
    temp.city || "",            // J
    temp.district || "",        // K
    temp.education || "",       // L
    temp.job || "",             // M
    temp.income_annual || "",   // N
    temp.photo_url || "",       // O
    "PENDING",                  // P (status)
    createdAt,                  // Q
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:Q",
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  return profile_id;
}

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
Photo: ${temp?.photo_url ? temp.photo_url : "Not saved"}

✅ Approve: approve ${profileId}
❌ Reject: reject ${profileId}`;

  await sendText(ADMIN_PHONE, msg);
}

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
  // Always respond immediately (Meta expects fast 200)
  res.sendStatus(200);

  try {
    const body = req.body;
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = normalizePhone(msg.from); // WhatsApp number without "+"
    const text = (msg.text?.body || "").trim();
    const msgType = msg.type; // "text", "image", etc.

    // ---------------- ADMIN COMMANDS (text only) ----------------
    if (text) {
      const lower = text.toLowerCase();

      if (lower === "stop" || lower === "cancel") {
        await setState(from, "", {});
        await sendText(from, "✅ Registration cancelled. Type *JOIN* to start again.");
        return;
      }

      if (lower.startsWith("approve") || lower.startsWith("reject")) {
        if (!isAdmin(from)) {
          await sendText(from, "❌ Only admin can approve/reject profiles.");
          return;
        }

        const parts = text.split(/\s+/);
        const cmd = (parts[0] || "").toLowerCase();
        const profileId = parts[1];

        if (!profileId) {
          await sendText(from, "Please send: approve MH-XXXX  OR  reject MH-XXXX");
          return;
        }

        const found = await findProfileById(profileId);
        if (!found) {
          await sendText(from, "Profile ID not found.");
          return;
        }

        const userPhone = found.row[1] || "";
        const newStatus = cmd === "approve" ? "APPROVED" : "REJECTED";

        await updateProfileStatus(found.rowIndex, newStatus);

        if (cmd === "approve") {
          await sendText(
            userPhone,
            `🎉 Congratulations!\nYour Profile ID *${profileId}* has been *APPROVED*.\n\nYou can now browse matches.`
          );
          await sendText(from, `✅ Profile ${profileId} approved successfully.`);
        } else {
          await sendText(
            userPhone,
            `❌ Your Profile ID *${profileId}* was *REJECTED* by admin.\n\nIf you think this is a mistake, please contact support.`
          );
          await sendText(from, `✅ Profile ${profileId} rejected successfully.`);
        }
        return;
      }
    }

    // ---------------- USER FLOW ----------------
    // If user sends JOIN (text)
    if (text && text.toUpperCase() === "JOIN") {
      // Block multiple profiles per phone (anti-fake)
      const existing = await findProfileByPhone(from);
      if (existing && existing.status && existing.status !== "REJECTED") {
        await sendText(
          from,
          `⚠️ You already have a profile.\nProfile ID: *${existing.profile_id}*\nStatus: *${existing.status}*\n\nIf you need changes, contact admin.`
        );
        return;
      }

      await setState(from, "ASK_NAME", {});
      await sendText(from, "✅ Matrimony Maharashtra\n\nReply with your *Name*:");
      return;
    }

    const st = await getState(from);
    const temp = JSON.parse(st.temp_data || "{}");

    if (!st.step) {
      // If no active flow and it's not JOIN, guide user
      if (text) await sendText(from, "Type *JOIN* to create your profile.");
      return;
    }

    // For all steps except photo, we need text input
    const requireText = (stepName) => {
      if (!text) {
        sendText(from, `Please reply with text for: *${stepName}*.`);
        return false;
      }
      return true;
    };

    if (st.step === "ASK_NAME") {
      if (!requireText("Name")) return;
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, "Good. Now reply with your *Surname*:");
      return;
    }

    if (st.step === "ASK_SURNAME") {
      if (!requireText("Surname")) return;
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendText(from, "Gender? Reply *Male* or *Female*:");
      return;
    }

    if (st.step === "ASK_GENDER") {
      if (!requireText("Gender")) return;
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
      if (!requireText("Date of Birth")) return;
      if (!isValidDOB(text)) {
        await sendText(from, "Please send DOB in *DD-MM-YYYY* format (example 05-11-1998)");
        return;
      }
      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, "Height? (Example: 5'6 or 168 cm):");
      return;
    }

    if (st.step === "ASK_HEIGHT") {
      if (!requireText("Height")) return;
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, "Religion? (Example: Hindu / Muslim / Jain / Buddhist):");
      return;
    }

    if (st.step === "ASK_RELIGION") {
      if (!requireText("Religion")) return;
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, "Caste? (Example: Maratha / Brahmin / Kunbi / etc.):");
      return;
    }

    if (st.step === "ASK_CASTE") {
      if (!requireText("Caste")) return;
      temp.caste = text;
      await setState(from, "ASK_CITY", temp);
      await sendText(from, "City? (Maharashtra only) Example: Pune / Nashik / Mumbai:");
      return;
    }

    if (st.step === "ASK_CITY") {
      if (!requireText("City")) return;
      temp.city = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, "District? Example: Pune / Nashik / Mumbai Suburban:");
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      if (!requireText("District")) return;
      temp.district = text;
      await setState(from, "ASK_EDU", temp);
      await sendText(from, "Education? (Example: B.Com / BE / MBA):");
      return;
    }

    if (st.step === "ASK_EDU") {
      if (!requireText("Education")) return;
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendText(from, "Job/Business? (Example: Engineer / Business / Govt Job):");
      return;
    }

    if (st.step === "ASK_JOB") {
      if (!requireText("Job")) return;
      temp.job = text;
      await setState(from, "ASK_INCOME", temp);
      await sendText(from, "Annual Income? (Example: 5 LPA / 10 LPA / 15 LPA):");
      return;
    }

    if (st.step === "ASK_INCOME") {
      if (!requireText("Income")) return;
      temp.income_annual = text;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, "Please send *one clear photo* (selfie or portrait). Photo is mandatory ✅");
      return;
    }

    // PHOTO step: accepts image messages (even when text is empty)
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

      // Get Meta media temporary URL
      const mediaUrl = await getMetaMediaUrl(mediaId);
      if (!mediaUrl) {
        await sendText(from, "Could not read photo URL. Please send again.");
        return;
      }

      // Try to store permanently in Drive (optional)
      let finalPhotoLink = mediaUrl;
      if (GOOGLE_DRIVE_FOLDER_ID) {
        try {
          const { bytes, contentType } = await downloadMetaMediaBytes(mediaUrl);
          const filename = `MH_${from}_${Date.now()}.jpg`;
          const driveLink = await uploadToDriveAndGetLink(bytes, contentType, filename);
          if (driveLink) finalPhotoLink = driveLink;
        } catch (e) {
          // Fallback to Meta URL if Drive upload fails
          console.error("Drive upload failed:", e?.response?.data || e.message);
        }
      }

      temp.photo_url = finalPhotoLink;

      // Create profile + notify admin
      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);

      // Clear state
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
