// index.js (Meta WhatsApp Cloud API + Google Sheets)
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; // any secret text you set
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Permanent token (or temp for testing)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Meta phone number id
const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const ADMIN_PHONE = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");

function normalizePhone(p) {
  return (p || "").toString().replace(/\D/g, "");
}
function isAdmin(from) {
  const f = normalizePhone(from);
  if (!ADMIN_PHONE) return false;
  // match full number OR match last 10 digits (safer if Meta sends without country sometimes)
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

const SERVICE_ACCOUNT_FILE = process.env.GOOGLE_SERVICE_ACCOUNT_FILE; // service_account.json

// ===================== Google Sheets =====================
async function getSheetsClient() {
 const { GoogleAuth } = require("google-auth-library");

const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
  return google.sheets({ version: "v4", auth });
}

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
  const now = new Date().toISOString();
  const temp_data = JSON.stringify(tempObj || {});

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "state!A:D",
  });
  const rows = res.data.values || [];

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone) {
      rowIndex = i + 1; // 1-based row
      break;
    }
  }

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "state!A:D",
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp_data, now]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `state!A${rowIndex}:D${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp_data, now]] },
    });
  }
}

async function createProfile(phone, temp) {
  const sheets = await getSheetsClient();
  const now = new Date().toISOString();
  const profile_id = `MH-${String(Math.floor(1000 + Math.random() * 9000))}`;

  const row = [
    profile_id,
    phone,
    temp.name || "",
    temp.surname || "",
    temp.gender || "",
    temp.date_of_birth || "",
    temp.religion || "",
    temp.caste || "",
    temp.city || "",
    temp.district || "",
    temp.education || "",
    temp.job || "",
    temp.income_annual || "",
    "PENDING",
    now,
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:O",
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });

  return profile_id;
}

// ===================== WhatsApp Cloud API =====================
async function sendText(to, text) {
  // IMPORTANT: This sends ONLY to "to". No broadcast.
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
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
  try {
    const body = req.body;

    // Always respond 200 fast
    res.sendStatus(200);

    if (!body?.entry?.[0]?.changes?.[0]?.value) return;

    const value = body.entry[0].changes[0].value;
    const msg = value.messages?.[0];
    if (!msg) return;

    const from = msg.from; // user number in international format (no +)
    const text = (msg.text?.body || "").trim();

   // ================= ADMIN APPROVAL =================

if (text.toLowerCase().startsWith("approve")) {

  if (!isAdmin(from)) {
    await sendText(from, "❌ Only admin can approve profiles.");
    return res.sendStatus(200);
  }

  const profileId = text.split(" ")[1]; // approve MH-8104

  if (!profileId) {
    await sendText(from, "Please send: approve MH-XXXX");
    return res.sendStatus(200);
  }

  const sheets = await getSheetsClient();
  const resData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:Z",
  });

  const rows = resData.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === profileId) {

      // Update status column (change index if needed)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `profiles!N${i + 1}`,
        valueInputOption: "RAW",
        requestBody: {
          values: [["APPROVED"]],
        },
      });

      const userPhone = rows[i][1]; // assuming column B has phone

      await sendText(userPhone,
        `🎉 Congratulations!
Your Profile ID *${profileId}* has been APPROVED.

You can now browse matches.`);

      await sendText(from,
        `✅ Profile ${profileId} approved successfully.`);

      return res.sendStatus(200);
    }
  }

  await sendText(from, "Profile ID not found.");
  return res.sendStatus(200);
}
    // Only handle text messages
    if (!text) return;

    // ---- Flow ----
    if (text.toUpperCase() === "JOIN") {
      await setState(from, "ASK_NAME", {});
      await sendText(from, "✅ Matrimony Maharashtra\n\nReply with your *Name*:");
      return;
    }

    const st = await getState(from);
    const temp = JSON.parse(st.temp_data || "{}");

    if (!st.step) {
      await sendText(from, "Type *JOIN* to create your profile.");
      return;
    }

    if (st.step === "ASK_NAME") {
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, "Good. Now reply with your *Surname*:");
      return;
    }

    if (st.step === "ASK_SURNAME") {
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendText(from, "Gender? Reply *Male* or *Female*:");
      return;
    }

    if (st.step === "ASK_GENDER") {
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
      temp.date_of_birth = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, "Religion? (Example: Hindu / Muslim / Jain / Buddhist):");
      return;
    }

    if (st.step === "ASK_RELIGION") {
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, "Caste? (Example: Maratha / Brahmin / Kunbi / etc.):");
      return;
    }

    if (st.step === "ASK_CASTE") {
      temp.caste = text;
      await setState(from, "ASK_CITY", temp);
      await sendText(from, "City? (Maharashtra only) Example: Pune / Nashik / Mumbai:");
      return;
    }

    if (st.step === "ASK_CITY") {
      temp.city = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, "District? Example: Pune / Nashik / Mumbai Suburban:");
      return;
    }

    if (st.step === "ASK_DISTRICT") {
      temp.district = text;
      await setState(from, "ASK_EDU", temp);
      await sendText(from, "Education? (Example: B.Com / BE / MBA):");
      return;
    }

    if (st.step === "ASK_EDU") {
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendText(from, "Job/Business? (Example: Engineer / Business / Govt Job):");
      return;
    }

    if (st.step === "ASK_JOB") {
      temp.job = text;
      await setState(from, "ASK_INCOME", temp);
      await sendText(from, "Annual Income? (Example: 5 LPA / 10 LPA / 15 LPA):");
      return;
    }

    if (st.step === "ASK_INCOME") {
      temp.income_annual = text;

      const profileId = await createProfile(from, temp);
      await setState(from, "", {}); // clear

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
