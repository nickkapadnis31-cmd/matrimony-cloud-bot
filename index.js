require("dotenv").config();

const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const { GoogleAuth } = require("google-auth-library");
const { Readable } = require("stream");

const app = express();
app.use(express.json());

// ===================== BRAND =====================
const BRAND_NAME = "नवीन नाती | Navin Nati";
const BRAND_TAGLINE = "तुमच्या जीवनसाथीच्या शोधाची नवी सुरुवात 💍";

// ===================== ENV =====================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

const MAX_PROFILES_PER_PHONE = 2;

// ===================== HELPERS =====================
function normalizePhone(p) {
  return (p || "").toString().replace(/\D/g, "");
}

function isAdmin(from) {
  const f = normalizePhone(from);
  return f === ADMIN_PHONE || f.slice(-10) === ADMIN_PHONE.slice(-10);
}

function calculateAge(dob) {
  const parts = dob.split("-");
  if (parts.length !== 3) return 0;
  const birthDate = new Date(parts[2], parts[1] - 1, parts[0]);
  const diff = Date.now() - birthDate.getTime();
  const ageDate = new Date(diff);
  return Math.abs(ageDate.getUTCFullYear() - 1970);
}

// ===================== GOOGLE AUTH =====================
async function getGoogleAuth() {
  return new GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive",
    ],
  });
}

async function getSheetsClient() {
  const auth = await getGoogleAuth();
  return google.sheets({ version: "v4", auth });
}

async function getDriveClient() {
  const auth = await getGoogleAuth();
  return google.drive({ version: "v3", auth });
}

// ===================== WHATSAPP =====================
async function sendText(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
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

// ===================== STATE =====================
async function getState(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "state!A:D",
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone)
      return { step: rows[i][1] || "", temp: rows[i][2] || "{}" };
  }
  return { step: "", temp: "{}" };
}

async function setState(phone, step, tempObj) {
  const sheets = await getSheetsClient();
  const now = new Date().toISOString();
  const temp = JSON.stringify(tempObj || {});

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "state!A:D",
  });

  const rows = res.data.values || [];
  let rowIndex = -1;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === phone) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "state!A:D",
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp, now]] },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `state!A${rowIndex}:D${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [[phone, step, temp, now]] },
    });
  }
}

// ===================== PROFILE HELPERS =====================
async function findProfilesByPhone(phone) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:Q",
  });

  const rows = res.data.values || [];
  return rows.slice(1).filter((r) => r[1] === phone);
}

async function createProfile(phone, temp) {
  const sheets = await getSheetsClient();
  const profileId = `MH-${Math.floor(1000 + Math.random() * 9000)}`;
  const now = new Date().toISOString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "profiles!A:Q",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        profileId,
        phone,
        temp.name,
        temp.surname,
        temp.gender,
        temp.date_of_birth,
        temp.height,
        temp.religion,
        temp.caste,
        temp.city,
        temp.district,
        temp.education,
        temp.job,
        temp.income,
        temp.photo_file_id,
        "PENDING",
        now
      ]],
    },
  });

  return profileId;
}

// ===================== WEBHOOK =====================
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const text = msg.text?.body?.trim();

    // ================= JOIN / NEWPROFILE =================
    if (text && (text.toUpperCase() === "JOIN" || text.toUpperCase() === "NEWPROFILE")) {

      const existing = await findProfilesByPhone(from);

      if (existing.length >= MAX_PROFILES_PER_PHONE) {
        await sendText(
          from,
          `⚠ You already have ${existing.length} profiles.\nDelete one before creating new.`
        );
        return;
      }

      await setState(from, "ASK_NAME", {});
      await sendText(
        from,
        `💍 ${BRAND_NAME}\n\n${BRAND_TAGLINE}\n\nReply with your *Name*:`
      );
      return;
    }

    const state = await getState(from);
    const temp = JSON.parse(state.temp);

    if (!state.step) {
      await sendText(from, `Type *JOIN* to create profile.`);
      return;
    }

    // ================= REGISTRATION FLOW =================
    if (state.step === "ASK_NAME") {
      temp.name = text;
      await setState(from, "ASK_SURNAME", temp);
      await sendText(from, "Surname?");
      return;
    }

    if (state.step === "ASK_SURNAME") {
      temp.surname = text;
      await setState(from, "ASK_GENDER", temp);
      await sendText(from, "Gender? Male / Female");
      return;
    }

    if (state.step === "ASK_GENDER") {
      temp.gender = text.toLowerCase();
      await setState(from, "ASK_DOB", temp);
      await sendText(from, "DOB (DD-MM-YYYY)");
      return;
    }

    if (state.step === "ASK_DOB") {
      const age = calculateAge(text);
      if (age < 18) {
        await sendText(from, "❌ Minimum age is 18.");
        await setState(from, "", {});
        return;
      }
      temp.date_of_birth = text;
      await setState(from, "ASK_HEIGHT", temp);
      await sendText(from, "Height?");
      return;
    }

    if (state.step === "ASK_HEIGHT") {
      temp.height = text;
      await setState(from, "ASK_RELIGION", temp);
      await sendText(from, "Religion?");
      return;
    }

    if (state.step === "ASK_RELIGION") {
      temp.religion = text;
      await setState(from, "ASK_CASTE", temp);
      await sendText(from, "Caste?");
      return;
    }

    if (state.step === "ASK_CASTE") {
      temp.caste = text;
      await setState(from, "ASK_CITY", temp);
      await sendText(from, "City?");
      return;
    }

    if (state.step === "ASK_CITY") {
      temp.city = text;
      await setState(from, "ASK_DISTRICT", temp);
      await sendText(from, "District?");
      return;
    }

    if (state.step === "ASK_DISTRICT") {
      temp.district = text;
      await setState(from, "ASK_EDU", temp);
      await sendText(from, "Education?");
      return;
    }

    if (state.step === "ASK_EDU") {
      temp.education = text;
      await setState(from, "ASK_JOB", temp);
      await sendText(from, "Job?");
      return;
    }

    if (state.step === "ASK_JOB") {
      temp.job = text;
      await setState(from, "ASK_INCOME", temp);
      await sendText(from, "Income?");
      return;
    }

    if (state.step === "ASK_INCOME") {
      temp.income = text;
      await setState(from, "ASK_PHOTO", temp);
      await sendText(from, "Send one clear photo.");
      return;
    }

    // ================= PHOTO UPLOAD =================
    if (state.step === "ASK_PHOTO") {

      if (msg.type !== "image") {
        await sendText(from, "Please send PHOTO only.");
        return;
      }

      const mediaId = msg.image.id;

      try {
        const mediaUrlRes = await axios.get(
          `https://graph.facebook.com/v20.0/${mediaId}`,
          { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
        );

        const mediaResponse = await axios.get(mediaUrlRes.data.url, {
          headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
          responseType: "arraybuffer",
        });

        const buffer = Buffer.from(mediaResponse.data);
        const stream = Readable.from(buffer);

        const drive = await getDriveClient();

        const file = await drive.files.create({
          requestBody: {
            name: `profile_${Date.now()}.jpg`,
            parents: [DRIVE_FOLDER_ID],
          },
          media: {
            mimeType: msg.image.mime_type || "image/jpeg",
            body: stream,
          },
        });

        temp.photo_file_id = file.data.id;

      } catch (err) {
        console.error("Drive upload error:", err.message);
        await sendText(from, "Photo upload failed. Try again.");
        return;
      }

      const profileId = await createProfile(from, temp);
      await setState(from, "", {});

      await sendText(
        from,
        `✅ Registration completed!\nProfile ID: *${profileId}*\nStatus: *PENDING approval*`
      );

      return;
    }

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
