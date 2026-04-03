// index.js — Vivaho WhatsApp Matrimony Bot (Meta Cloud API + Google Sheets + Cloudinary)
//
// Brand: Vivaho
// Tagline: “नवीन नाती – विश्वासाने जोडलेली.”
//
// Features:
// - Max 2 profiles per phone
// - MYPROFILES, DELETE MH-XXXX
// - Admin approve/reject
// - Only APPROVED can browse matches; results only APPROVED
// - 18+ enforced
// - Photo stored in Cloudinary
// - SEARCH / MATCHES with filters + NEXT/PREV
// - DETAILS without name
// - INTEREST / ACCEPT / REJECT
// - Interactive Buttons + Lists for guided UX
//
// PROFILES SHEET (A–U) columns:
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
// Q income_annual   (stores monthly income range text now)
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
// ===================== GEO HELPERS =====================

async function getLatLonFromPlace(place) {
  const key = process.env.OPENCAGE_API_KEY || "";
  if (!key || !place) return null;

  try {
    const url = "https://api.opencagedata.com/geocode/v1/json";
    const resp = await axios.get(url, {
      params: {
        q: place,
        key,
        limit: 1,
        countrycode: "in",
      },
      timeout: 15000,
    });

    const result = resp.data?.results?.[0];
    if (!result?.geometry) return null;

    return {
      lat: result.geometry.lat,
      lon: result.geometry.lng,
      timezone:
        Number(result.annotations?.timezone?.offset_string?.slice(0, 3)) +
          (Number(result.annotations?.timezone?.offset_string?.slice(4, 6)) || 0) / 60 || 5.5,
      formatted: result.formatted || place,
    };
  } catch (e) {
    console.error("OpenCage error:", e?.response?.data || e.message);
    return null;
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

function incomeBandRank(v) {
  const x = cleanLower(v);
  if (x.includes("above 3") || x.includes("3l+") || x.includes("3,00,000")) return 4;
  if (x.includes("1,00,000") || x.includes("1l - 3l") || x.includes("1l – 3l") || x.includes("1l-3l")) return 3;
  if ((x.includes("50") && x.includes("1l")) || x.includes("50,000 to 1,00,000")) return 2;
  if (x.includes("up to 50") || x.includes("upto 50")) return 1;
  return null;
}

function maritalStatusFromInput(v) {
  const x = cleanLower(v);
  if (x.includes("unmarried") || x.includes("अविवाहित")) return "Unmarried";
  if (x.includes("divorce") || x.includes("घटस्फोट")) return "Divorce";
  if (x.includes("widower") || x.includes("widow") || x.includes("विधुर") || x.includes("विधवा")) {
    return "Widower/Widow";
  }
  if (x.includes("any") || x.includes("no preference")) return "ANY";
  return "";
}

function normalizeEducationInput(v) {
  const x = cleanUpper(v);
  if (x === "ANY") return "ANY";
  if (x === "GRADUATE") return "GRADUATE";
  if (x === "POSTGRADUATE" || x === "POSTGRAD") return "POSTGRADUATE";
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
const MAX_DETAILS_PER_MONTH = 5;
const MAX_INTEREST_PER_MONTH = 5;
const RESULTS_PAGE_SIZE = 5;


// ===================== Shiv Samadhan =====================
const SHIV_SERVICE_NAME = "Shiv Samadhan";
const SHIV_SERVICE_TAGLINE = "हर समस्या का समाधान";
const SHIV_ASTROLOGY_API_URL = process.env.SHIV_ASTROLOGY_API_URL || "";
const SHIV_ASTROLOGY_API_KEY = process.env.SHIV_ASTROLOGY_API_KEY || "";
const SHIV_QR_IMAGE_URL = process.env.SHIV_QR_IMAGE_URL || "";
const SHIV_UPI_ID = process.env.SHIV_UPI_ID || "";

const SHIV_PRODUCT_IMAGES = {
  BHAIRAV_YANTRA: process.env.SHIV_IMG_BHAIRAV_YANTRA || "",
  LAXMI_KUBER_COIN: process.env.SHIV_IMG_LAXMI_KUBER_COIN || "",
  LAXMI_KUBER_YANTRA: process.env.SHIV_IMG_LAXMI_KUBER_YANTRA || "",
  RUDRAKSHA_BRACELET: process.env.SHIV_IMG_RUDRAKSHA_BRACELET || "",
  NAZAR_BATTU: process.env.SHIV_IMG_NAZAR_BATTU || "",
  CRYSTAL_TURTLE: process.env.SHIV_IMG_CRYSTAL_TURTLE || "",
  KAMDHENU_COW: process.env.SHIV_IMG_KAMDHENU_COW || "",
  SURYA_FRAME: process.env.SHIV_IMG_SURYA_FRAME || "",
  SHIV_KADA: process.env.SHIV_IMG_SHIV_KADA || "",
};

const SHIV_PRODUCTS = {
  BHAIRAV_YANTRA: { key: "BHAIRAV_YANTRA", title: "भैरव यंत्र", shortTitle: "भैरव ₹301", price: 301, image: () => SHIV_PRODUCT_IMAGES.BHAIRAV_YANTRA },
  LAXMI_KUBER_COIN: { key: "LAXMI_KUBER_COIN", title: "लक्ष्मी-कुबेर कॉइन", shortTitle: "कॉइन ₹301", price: 301, image: () => SHIV_PRODUCT_IMAGES.LAXMI_KUBER_COIN },
  LAXMI_KUBER_YANTRA: { key: "LAXMI_KUBER_YANTRA", title: "लक्ष्मी-कुबेर यंत्र", shortTitle: "यंत्र ₹301", price: 301, image: () => SHIV_PRODUCT_IMAGES.LAXMI_KUBER_YANTRA },
  RUDRAKSHA_BRACELET: { key: "RUDRAKSHA_BRACELET", title: "रुद्राक्ष ब्रेसलेट", shortTitle: "ब्रेसलेट ₹501", price: 501, image: () => SHIV_PRODUCT_IMAGES.RUDRAKSHA_BRACELET },
  NAZAR_BATTU: { key: "NAZAR_BATTU", title: "नजर बट्टू", shortTitle: "नजर ₹501", price: 501, image: () => SHIV_PRODUCT_IMAGES.NAZAR_BATTU },
  CRYSTAL_TURTLE: { key: "CRYSTAL_TURTLE", title: "क्रिस्टल कछुआ", shortTitle: "कछुआ ₹501", price: 501, image: () => SHIV_PRODUCT_IMAGES.CRYSTAL_TURTLE },
  KAMDHENU_COW: { key: "KAMDHENU_COW", title: "कामधेनु गाय", shortTitle: "कामधेनु ₹1001", price: 1001, image: () => SHIV_PRODUCT_IMAGES.KAMDHENU_COW },
  SURYA_FRAME: { key: "SURYA_FRAME", title: "सूर्य फ्रेम", shortTitle: "सूर्य ₹1001", price: 1001, image: () => SHIV_PRODUCT_IMAGES.SURYA_FRAME },
  SHIV_KADA: { key: "SHIV_KADA", title: "शिव कड़ा", shortTitle: "शिव कड़ा ₹1001", price: 1001, image: () => SHIV_PRODUCT_IMAGES.SHIV_KADA },
};

const SHIV_PROBLEMS = {
  MARRIAGE: {
    key: "MARRIAGE",
    title: "शादी में देरी / समस्या",
    hook: "क्या शादी में देरी हो रही है या सही रिश्ता नहीं मिल रहा?",
    emotional: `समझ गया 🙏

शादी में देरी या बार-बार रुकावट आना कई बार ग्रहों के प्रभाव और energy imbalance से जुड़ा होता है।

👉 सही उपाय से विवाह के योग मजबूत हो सकते हैं

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "RUDRAKSHA_BRACELET", "KAMDHENU_COW"],
  },
  RELATION_KALAH: {
    key: "RELATION_KALAH",
    title: "रिश्तों में कलह / तनाव",
    hook: "क्या रिश्तों में बार-बार तनाव, झगड़े या दूरी बढ़ रही है?",
    emotional: `समझ गया 🙏

रिश्तों में बार-बार झगड़ा, misunderstanding या दूरी negative energy और imbalance का संकेत हो सकता है।

👉 सही उपाय से रिश्तों में शांति और समझ बढ़ सकती है

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "CRYSTAL_TURTLE", "SURYA_FRAME"],
  },
  JOB: {
    key: "JOB",
    title: "नौकरी / करियर समस्या",
    hook: "क्या नौकरी में रुकावट, growth delay या confidence की कमी महसूस हो रही है?",
    emotional: `समझ गया 🙏

नौकरी में रुकावट, growth न होना या बार-बार failure energy blockage और ग्रह प्रभाव से जुड़ा हो सकता है।

👉 सही उपाय से career में प्रगति संभव है

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "RUDRAKSHA_BRACELET", "SURYA_FRAME"],
  },
  LOAN: {
    key: "LOAN",
    title: "लोन नहीं भर पा रहे",
    hook: "क्या EMI का दबाव बढ़ रहा है और कर्ज कम नहीं हो रहा?",
    emotional: `समझ गया 🙏

लोन का बढ़ता बोझ और repayment में कठिनाई financial imbalance और blockage का संकेत हो सकता है।

👉 सही उपाय से स्थिति में सुधार आ सकता है

⬇️ समाधान देखें`,
    products: ["LAXMI_KUBER_YANTRA", "RUDRAKSHA_BRACELET", "SURYA_FRAME"],
  },
  RECOVERY: {
    key: "RECOVERY",
    title: "दिया पैसा वापस नहीं मिल रहा",
    hook: "क्या दिया हुआ पैसा अटका हुआ है और वापस नहीं मिल रहा?",
    emotional: `समझ गया 🙏

दिया हुआ पैसा वापस न मिलना कई बार नकारात्मक ऊर्जा और परिस्थिति imbalance से जुड़ा होता है।

👉 सही उपाय से पैसा वापस मिलने के योग बन सकते हैं

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "LAXMI_KUBER_COIN", "RUDRAKSHA_BRACELET"],
  },
  CHILDLESS: {
    key: "CHILDLESS",
    title: "बच्चे नहीं हो रहे",
    hook: "क्या संतान प्राप्ति में देरी हो रही है?",
    emotional: `समझ गया 🙏

संतान प्राप्ति में देरी कई बार energy imbalance और ग्रह प्रभाव से जुड़ी होती है।

👉 सही उपाय से संतान सुख के योग मजबूत हो सकते हैं

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "RUDRAKSHA_BRACELET", "KAMDHENU_COW"],
  },
  GRAH_ASHANTI: {
    key: "GRAH_ASHANTI",
    title: "गृह अशांति",
    hook: "क्या घर में बार-बार तनाव, झगड़े या बेचैनी बनी रहती है?",
    emotional: `समझ गया 🙏

घर में बार-बार तनाव, झगड़े या बेचैनी negative energy का संकेत हो सकता है।

👉 सही उपाय से घर में शांति और सुख बढ़ सकता है

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "RUDRAKSHA_BRACELET", "KAMDHENU_COW"],
  },
  MAN_ASHANTI: {
    key: "MAN_ASHANTI",
    title: "मन अशांति / तनाव",
    hook: "क्या बार-बार चिंता, डर या stress बढ़ रहा है?",
    emotional: `समझ गया 🙏

बार-बार चिंता, stress या मन का अशांत रहना energy imbalance का संकेत हो सकता है।

👉 सही उपाय से मन शांत और स्थिर हो सकता है

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "RUDRAKSHA_BRACELET", "SURYA_FRAME"],
  },
  SMALL_CHILD: {
    key: "SMALL_CHILD",
    title: "छोटे बच्चों की परेशानियां",
    hook: "क्या छोटे बच्चों में गुस्सा, जिद या बार-बार परेशानी हो रही है?",
    emotional: `समझ गया 🙏

कई बार छोटे बच्चों का गुस्सा, जिद या बार-बार बीमार होना घर की energy imbalance और नजर के प्रभाव से जुड़ा होता है।

👉 सही उपाय से बच्चे शांत और positive हो सकते हैं

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "NAZAR_BATTU", "RUDRAKSHA_BRACELET"],
  },
  BIG_CHILD: {
    key: "BIG_CHILD",
    title: "बड़े बच्चों की परेशानियां",
    hook: "क्या बड़े बच्चों का behavior, गुस्सा या attitude बढ़ रहा है?",
    emotional: `समझ गया 🙏

Teenage या बड़े बच्चों का behavior change होना, गुस्सा, बात न मानना या ध्यान न लगना mental और energy imbalance से जुड़ा हो सकता है।

👉 सही दिशा और उपाय से सुधार संभव है

⬇️ समाधान देखें`,
    products: ["BHAIRAV_YANTRA", "NAZAR_BATTU", "RUDRAKSHA_BRACELET"],
  },
};

function isGreetingInput(v) {
  const x = cleanUpper(v);
  return ["HI", "HELLO", "HII", "HEY", "START", "MENU", "HOME"].includes(x);
}

function formatDobForApi(dob) {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(dob || "")) return dob || "";
  const [dd, mm, yyyy] = dob.split("-");
  return `${yyyy}-${mm}-${dd}`;
}

function numerologyNumberFromDob(dob) {
  const digits = String(dob || "").replace(/\D/g, "");
  if (!digits) return 0;
  let n = digits.split("").reduce((a, b) => a + Number(b || 0), 0);
  while (n > 9) n = String(n).split("").reduce((a, b) => a + Number(b || 0), 0);
  return n || 0;
}

function luckyNumbersForNumerology(n) {
  const map = {
    1: [1, 3, 5], 2: [2, 6, 7], 3: [3, 6, 9], 4: [1, 4, 8], 5: [1, 5, 6],
    6: [3, 6, 9], 7: [2, 7, 9], 8: [1, 5, 8], 9: [3, 6, 9],
  };
  return map[n] || [n || 1];
}

function luckyColoursForNumerology(n) {
  const map = {
    1: ["Gold", "Orange"],
    2: ["White", "Silver"],
    3: ["Yellow", "Orange"],
    4: ["Blue", "Grey"],
    5: ["Green", "Light Blue"],
    6: ["Pink", "Cream"],
    7: ["White", "Light Yellow"],
    8: ["Navy Blue", "Brown"],
    9: ["Red", "Maroon"],
  };
  return map[n] || ["Gold", "Yellow"];
}

function approxRashiFromDob(dob) {
  if (!/^\d{2}-\d{2}-\d{4}$/.test(dob || "")) return "मेष";
  const [dd, mm] = dob.split("-").map((x) => parseInt(x, 10));
  const m = mm, d = dd;
  if ((m === 4 && d >= 14) || (m === 5 && d <= 14)) return "मेष";
  if ((m === 5 && d >= 15) || (m === 6 && d <= 14)) return "वृषभ";
  if ((m === 6 && d >= 15) || (m === 7 && d <= 14)) return "मिथुन";
  if ((m === 7 && d >= 15) || (m === 8 && d <= 14)) return "कर्क";
  if ((m === 8 && d >= 15) || (m === 9 && d <= 15)) return "सिंह";
  if ((m === 9 && d >= 16) || (m === 10 && d <= 15)) return "कन्या";
  if ((m === 10 && d >= 16) || (m === 11 && d <= 14)) return "तुला";
  if ((m === 11 && d >= 15) || (m === 12 && d <= 14)) return "वृश्चिक";
  if ((m === 12 && d >= 15) || (m === 1 && d <= 13)) return "धनु";
  if ((m === 1 && d >= 14) || (m === 2 && d <= 12)) return "मकर";
  if ((m === 2 && d >= 13) || (m === 3 && d <= 14)) return "कुंभ";
  return "मीन";
}

function numerologyInsight(n) {
  const map = {
    1: "Numerology Number 1 वाले लोग leadership nature के होते हैं, लेकिन impatience की वजह से decisions जल्दी ले लेते हैं।",
    2: "Numerology Number 2 वाले लोग sensitive और emotional होते हैं, लेकिन overthinking की वजह से stress बढ़ सकता है।",
    3: "Numerology Number 3 वाले लोग expressive और creative होते हैं, लेकिन focus टूट सकता है।",
    4: "Numerology Number 4 वाले लोगों को मेहनत के बाद भी results delay से मिल सकते हैं।",
    5: "Numerology Number 5 वाले लोग smart और fast thinker होते हैं, लेकिन stability maintain करना मुश्किल हो सकता है।",
    6: "Numerology Number 6 वाले लोग family-oriented होते हैं, लेकिन जिम्मेदारियों का pressure ज्यादा महसूस कर सकते हैं।",
    7: "Numerology Number 7 वाले लोग deep thinker होते हैं, लेकिन loneliness या overthinking बढ़ सकती है।",
    8: "Numerology Number 8 वाले लोगों की life में ups and downs strong रहते हैं और मेहनत के बाद results देर से मिल सकते हैं।",
    9: "Numerology Number 9 वाले लोग strong और passionate होते हैं, लेकिन emotional intensity decisions को affect कर सकती है।",
  };
  return map[n] || "आपकी life में कुछ चीजें delay से होती हैं, लेकिन सही guidance से support मिल सकता है।";
}

function rashiInsight(rashi) {
  const map = {
    "मेष": "मेष राशि वाले लोग energetic होते हैं, लेकिन impatience challenges बढ़ा सकता है।",
    "वृषभ": "वृषभ राशि वाले लोग stable होते हैं, लेकिन change accept करने में समय लेते हैं।",
    "मिथुन": "मिथुन राशि वाले लोग intelligent होते हैं, लेकिन mind जल्दी distract हो सकता है।",
    "कर्क": "कर्क राशि वाले लोग emotional होते हैं, लेकिन attachment और चिंता बढ़ सकती है।",
    "सिंह": "सिंह राशि वाले लोग confident होते हैं, लेकिन respect की strong need रहती है।",
    "कन्या": "कन्या राशि वाले लोग practical होते हैं, लेकिन overthinking बढ़ सकती है।",
    "तुला": "तुला राशि वाले लोग balance चाहते हैं, लेकिन decision delay हो सकता है।",
    "वृश्चिक": "वृश्चिक राशि वाले लोग intense होते हैं, लेकिन emotions deep रहते हैं।",
    "धनु": "धनु राशि वाले लोग optimistic होते हैं, लेकिन consistency break हो सकती है।",
    "मकर": "मकर राशि वाले लोग disciplined होते हैं, लेकिन pressure ज्यादा लेते हैं।",
    "कुंभ": "कुंभ राशि वाले लोग unique सोच रखते हैं, लेकिन emotional disconnect हो सकता है।",
    "मीन": "मीन राशि वाले लोग imaginative होते हैं, लेकिन practical focus टूट सकता है।",
  };
  return map[rashi] || "राशि की energy आपकी life pattern को subtly affect कर सकती है।";
}

async function getShivReading(temp) {
  const numerology = numerologyNumberFromDob(temp.dob || "");
  let reading = {
    numerology,
    luckyNumbers: luckyNumbersForNumerology(numerology),
    rashi: approxRashiFromDob(temp.dob || ""),
    nakshatra: "",
    exact: false,
  };
const geo = await getLatLonFromPlace(temp.birth_place || "");
const lat = geo?.lat;
const lon = geo?.lon;
  
  if (SHIV_ASTROLOGY_API_URL && SHIV_ASTROLOGY_API_KEY && temp.dob && temp.birth_place) {
    try {
      const resp = await axios.post(
        SHIV_ASTROLOGY_API_URL,
        {
          dob: formatDobForApi(temp.dob),
          birth_time: temp.birth_time || "",
          birth_place: temp.birth_place || "",
          language: "hi",
        },
        {
          headers: {
            Authorization: `Bearer ${SHIV_ASTROLOGY_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 20000,
        }
      );
      const data = resp.data || {};
      reading = {
        numerology: Number(data.numerology || numerology),
        luckyNumbers: Array.isArray(data.lucky_numbers) && data.lucky_numbers.length ? data.lucky_numbers : luckyNumbersForNumerology(numerology),
        rashi: data.rashi || data.moon_sign || reading.rashi,
        nakshatra: data.nakshatra || "",
        exact: Boolean(data.rashi || data.moon_sign),
      };
    } catch (err) {
      console.error("Shiv astrology API fallback:", err?.response?.data || err.message);
    }
  }

  return reading;
}

function buildShivResultMessage(temp, reading) {
  const colours = luckyColoursForNumerology(reading.numerology || 1).join(", ");

  return `🔱 शिव समाधान 🔱

🔮 *आपकी Basic Reading*

• Numerology Number: *${reading.numerology || "-"}*
• Lucky Number: *${(reading.luckyNumbers || []).join(", ")}*
• Rashi: *${reading.rashi || "-"}*${reading.nakshatra ? `
• Nakshatra: *${reading.nakshatra}*` : ""}
• Lucky Colour: *${colours}*

${numerologyInsight(reading.numerology)}

${rashiInsight(reading.rashi)}

👉 आपके लिए सही दिशा और संतुलन बहुत जरूरी है

✨ सही मार्गदर्शन से आपकी life में positivity आ सकती है

अगर आपको कोई बात सता रही है
या किसी बात की परेशानी है,
तो आगे बढ़ें 👇

🌸 आपका भविष्य मंगलमय हो 🌸`;
}

async function showMainServiceMenu(to) {
  await sendButtons(
    to,
    "आप किस सेवा में interested हैं?\n\n💍 *Vivaho Matrimony*\n👉 अपना जीवनसाथी खोजें\n\n🔱 *Shiv Samadhan*\n👉 ज्योतिष / आध्यात्मिक समाधान पाएं",
    [
      { id: "VIVAHO_HOME", title: "Vivaho" },
      { id: "SHIV_HOME", title: "Shiv Samadhan" },
    ]
  );
}

async function showShivIntro(to) {
  await sendButtons(
    to,
    `🔱 शिव समाधान में आपका स्वागत है 🙏

सही मार्गदर्शन और उपाय से आपका भविष्य बेहतर बन सकता है ✨

जीवन की समस्याओं का समाधान सही दिशा और सकारात्मक ऊर्जा से संभव है।

⬇️ अधिक जानकारी के लिए आगे बढ़ें

🌸 आपका भविष्य मंगलमय हो 🌸`,
    [
      { id: "SHIV_PROCEED", title: "Proceed" },
      { id: "SHIV_START_AGAIN", title: "Start Again" },
    ]
  );
}

async function showShivProblemList(to) {
  await sendList(to, "अपनी समस्या चुनें", "Select", [
    { id: "SHIV_PROB_MARRIAGE", title: "शादी में देरी" },
    { id: "SHIV_PROB_RELATION_KALAH", title: "रिश्तों में तनाव" },
    { id: "SHIV_PROB_JOB", title: "नौकरी / करियर" },
    { id: "SHIV_PROB_LOAN", title: "लोन समस्या" },
    { id: "SHIV_PROB_RECOVERY", title: "पैसा वापस नहीं" },
    { id: "SHIV_PROB_CHILDLESS", title: "बच्चे नहीं हो रहे" },
    { id: "SHIV_PROB_GRAH_ASHANTI", title: "गृह अशांति" },
    { id: "SHIV_PROB_MAN_ASHANTI", title: "मन अशांति / तनाव" },
    { id: "SHIV_PROB_SMALL_CHILD", title: "छोटे बच्चों की" },
    { id: "SHIV_PROB_BIG_CHILD", title: "बड़े बच्चों की" },
  ], "Select", "Shiv Samadhan");
}

async function showShivProducts(to, temp) {
  const problem = SHIV_PROBLEMS[temp.selectedProblem] || null;
  if (!problem) {
    await sendText(to, "Please select a problem first.\nपहले अपनी problem चुनिए।");
    return;
  }
  const products = problem.products.map((k) => SHIV_PRODUCTS[k]).filter(Boolean);
  await sendText(
    to,
    `नीचे दी गई वस्तुएं आपकी DOB, personal details और चुनी हुई समस्या के आधार पर तैयार की जाएंगी।\n\nयह आपके लिए विशेष रूप से तैयार किया जाएगा।`
  );
  await sendList(
    to,
    "अपना product चुनें",
    "Products",
    products.map((p) => ({ id: `SHIV_PRODUCT_${p.key}`, title: trimTo(p.title, 24) })),
    "Available Products"
  );
  await sendButtons(to, "आगे क्या करना है?", [{ id: "SHIV_START_AGAIN", title: "Start Again" }]);
}

async function showShivProductDetail(to, productKey, temp) {
  const product = SHIV_PRODUCTS[productKey];
  if (!product) return;
  temp.selectedProduct = product.key;
  temp.selectedProductTitle = product.title;
  temp.selectedProductPrice = product.price;
  await setState(to, "SHIV_PRODUCT_DETAIL", temp);
  const img = product.image();
  if (img) {
    await sendImageByLink(to, img, `${product.title}\n₹${product.price}`);
  }
  await sendButtons(
    to,
    `*${product.title}*\n\nयह आपकी DOB, personal details और चुनी हुई समस्या के आधार पर specially तैयार किया जाएगा।\n\nकई लोगों को regular use के साथ कुछ ही दिनों में results feel हुए हैं।\n\n💰 Price: ₹${product.price}`,
    [
      { id: "SHIV_BUY_NOW", title: "Buy Now" },
      { id: "SHIV_START_AGAIN", title: "Start Again" },
    ]
  );
}

async function sendShivAdminOrder(temp, userPhone) {
  const img = SHIV_PRODUCTS[temp.selectedProduct || ""]?.image?.() || "";
  if (img) {
    try {
      await sendImageByLink(ADMIN_PHONE, img, `New Order\n${temp.selectedProductTitle || ""} | ₹${temp.selectedProductPrice || ""}`);
    } catch (e) {
      console.error("Admin image send failed:", e?.response?.data || e.message);
    }
  }
  const adminBody = `🆕 *New Shiv Samadhan Order*\n\nName: ${temp.name || ""}\nPhone: ${userPhone}\nDOB: ${temp.dob || ""}\nBirth Time: ${temp.birth_time || "SKIP"}\nBirth Place: ${temp.birth_place || ""}\n\nProblem: ${SHIV_PROBLEMS[temp.selectedProblem]?.title || temp.selectedProblem || ""}\nProduct: ${temp.selectedProductTitle || ""}\nPrice: ₹${temp.selectedProductPrice || ""}\n\nDelivery Details:\n${temp.delivery_details || ""}\n\nPayment: Done ✅`;
  await sendText(ADMIN_PHONE, adminBody);
  await sendButtons(ADMIN_PHONE, "Confirm this order", [
    { id: `SHIV_ADMIN_CONFIRM_${userPhone}`, title: "CONFIRM" },
    { id: `SHIV_ADMIN_REJECT_${userPhone}`, title: "NOT CONFIRMED" },
  ]);
}

// ===================== Messages =====================
const WELCOME_MSG =
`💍 *${BRAND_NAME}*
${BRAND_SUBTITLE}
${BRAND_TAGLINE}

Find the right match with trust ❤️
विश्वास के साथ सही रिश्ता चुनिए।`;

const COMMANDS_MSG =
`📘 *${BRAND_NAME}* — How it works
यहाँ सब कुछ WhatsApp पर easy तरीके से होता है।

*JOIN* → Create profile
नई प्रोफाइल बनाइए

*SEARCH* → Find matches
रिश्ते खोजिए

*DETAILS MH-XXXX* → View profile details
प्रोफाइल की पूरी जानकारी देखिए

*INTEREST MH-XXXX* → Show interest
Interest भेजिए

*MYPROFILES* → View your profiles
अपनी प्रोफाइल्स देखिए

*DELETE MH-XXXX* → Delete your profile
अपनी प्रोफाइल delete कीजिए

*STOP* → Stop current process
अभी का process बंद कीजिए

⏳ Only *APPROVED* users can use *SEARCH / DETAILS / INTEREST*.
सिर्फ *APPROVED* प्रोफाइल्स ही *SEARCH / DETAILS / INTEREST* use कर सकती हैं।`;

const THANK_YOU_MARKETING_MSG =
`🙏 Thank you for connecting with *${BRAND_NAME}*.
धन्यवाद, आपने *${BRAND_NAME}* से जुड़कर अच्छा किया।

Message anytime to continue ❤️
जब चाहें फिर से message करके शुरू कीजिए।

📩 Send *JOIN* to begin
शुरू करने के लिए *JOIN* भेजिए।

*${BRAND_NAME}*
${BRAND_TAGLINE}`;

const PENDING_MSG =
`💍 *${BRAND_NAME}*

Approval pending hai.
आपका प्रोफाइल अभी approve नहीं हुआ है।

⏳ Please wait for admin approval.
कृपया admin approval का wait कीजिए।

Approval के बाद नीचे वाला button tap कीजिए 👇`;

function makeInvalidReplyMsg(originalPrompt) {
  return `❌ Invalid response.

Please tap the correct option or type *STOP*.
सही option tap कीजिए या *STOP* लिखिए।

${originalPrompt}`;
}

function getPromptByStep(step) {
  switch (step) {
    case "ASK_NAME":
      return "Please enter your *Name*\nकृपया अपना *नाम* लिखें";
    case "ASK_SURNAME":
      return "Please enter your *Surname*\nकृपया अपना *Surname / उपनाम* लिखें";
    case "ASK_DOB":
      return "Enter Date of Birth\nजन्मतिथि लिखें\n\nFormat: *DD-MM-YYYY*\nExample: 05-11-1998";
    case "ASK_HEIGHT":
      return "Enter Height\nऊंचाई लिखें\n\nExample: *5'6* or *168 cm*";
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
      return "Enter preferred age range\nपसंदीदा उम्र सीमा लिखें\n\nExample: *23-30*\nOr tap *SKIP*";
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

async function sendJoinStopButtons(to, body = "Choose an option\nकृपया एक option चुनें") {
  await sendButtons(to, body, [
    { id: "JOIN", title: "JOIN" },
    { id: "SEARCH", title: "SEARCH" },
    { id: "STOP", title: "STOP" },
  ]);
}

async function sendProceedStopButtons(to) {
  await sendButtons(to, "Do you want to continue?\nक्या आप आगे बढ़ना चाहते हैं?", [
    { id: "PROCEED", title: "Proceed" },
    { id: "STOP", title: "Stop" },
  ]);
}

async function sendSearchButton(to, body = "Tap below to search\nSearch शुरू करने के लिए नीचे tap कीजिए") {
  await sendButtons(to, body, [{ id: "SEARCH", title: "SEARCH" }]);
}

async function sendSearchAgainButton(to, body = "No matches found.\nकोई match नहीं मिला।") {
  await sendButtons(to, `${body}\n\nTap below to start a new search.\nनई search शुरू करने के लिए नीचे tap कीजिए।`, [
    { id: "SEARCH", title: "Search Again" },
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
    temp.marital_status || "",
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
`🆕 *New Registration*

💍 *${BRAND_NAME}*

ID: *${profileId}*
Phone: ${phone}

Name: ${(temp?.name || "")} ${(temp?.surname || "")}
Gender: ${temp?.gender || ""}
Marital: ${temp?.marital_status || ""}

Native: ${temp?.native_place || ""}
Work: ${temp?.work_city || ""}

👇 Use buttons below to approve or reject`;

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
  const maritalTxt = p.marital_status || "NA";

  return `• ${p.profile_id} | Age: ${ageTxt} | Status: ${maritalTxt} | Native: ${nativeTxt} | Work: ${workTxt} | ${p.education} | ${jobTitleTxt}`;
}

function getSearchResultChunk(results, page = 0) {
  const start = page * RESULTS_PAGE_SIZE;
  const end = start + RESULTS_PAGE_SIZE;
  return results.slice(start, end);
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

    if (opts.maritalStatus && cleanUpper(opts.maritalStatus) !== "ANY") {
      if (cleanLower(p.marital_status) !== cleanLower(opts.maritalStatus)) continue;
    }

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

async function sendResultsPage(to, searchState) {
  const { results = [], page = 0 } = searchState;
  if (!results.length) {
    await sendText(to, `💍 *${BRAND_NAME}*\n\nNo matches found.\nकोई matching profile नहीं मिला।\n\nStarting new search...\nनई search शुरू की जा रही है...`);
    await setTimeout(() => {}, 0);
    await sendSearchAgainButton(to);
    return;
  }

  const start = page * RESULTS_PAGE_SIZE;
  const end = start + RESULTS_PAGE_SIZE;
  const chunk = results.slice(start, end);

  let msg = `💍 *${BRAND_NAME}*\n\n🔎 Search Results (${start + 1}-${Math.min(end, results.length)} of ${results.length})\n\n`;
  msg += chunk.map(buildProfileCardLine).join("\n");
  msg += `\n\nSelect a Profile ID from the list below.\nनीचे list से Profile ID चुनिए।`;

  await sendText(to, msg);

  await sendList(
    to,
    "Choose a profile\nएक profile चुनिए",
    "Select Profile",
    chunk.map((p) => ({
      id: `SELECT_RESULT_${p.profile_id}`,
      title: p.profile_id,
      description: `${p.native_place || "NA"} | ${p.education || "NA"} | ${p.job_title || p.job || "NA"}`,
    })),
    "Search Results"
  );

  const totalPages = Math.ceil(results.length / RESULTS_PAGE_SIZE);
  if (totalPages <= 1) {
    await sendButtons(to, "Next action\nआगे क्या करना है?", [
      { id: "SEARCH", title: "Search Again" },
    ]);
  } else if (page === 0) {
    await sendButtons(to, "Next action\nआगे क्या करना है?", [
      { id: "NEXT", title: "NEXT" },
      { id: "SEARCH", title: "Search Again" },
    ]);
  } else if (page >= totalPages - 1) {
    await sendButtons(to, "Next action\nआगे क्या करना है?", [
      { id: "PREV", title: "PREV" },
      { id: "SEARCH", title: "Search Again" },
    ]);
  } else {
    await sendButtons(to, "Next action\nआगे क्या करना है?", [
      { id: "PREV", title: "PREV" },
      { id: "NEXT", title: "NEXT" },
      { id: "SEARCH", title: "Search Again" },
    ]);
  }
}

async function sendSelectedResultActions(to, profileId) {
  await sendButtons(
    to,
    `Selected Profile: ${profileId}\nचुना गया profile: ${profileId}`,
    [
      { id: `DETAILS_${profileId}`, title: "DETAILS" },
      { id: `INTEREST_${profileId}`, title: "INTEREST" },
      { id: "BACK_TO_LIST", title: "BACK" },
    ]
  );
}

async function sendSelfProfileActionButtons(to, profileId) {
  await sendButtons(
    to,
    `Your profile: ${profileId}\nयह आपकी अपनी profile है।`,
    [
      { id: `SELF_DELETE_${profileId}`, title: "DELETE" },
      { id: "MYPROFILES", title: "MYPROFILES" },
      { id: "SELF_MORE", title: "MORE" },
    ]
  );

  await sendButtons(
    to,
    "More actions\nऔर options",
    [
      { id: "JOIN", title: "JOIN" },
      { id: "SEARCH", title: "SEARCH" },
      { id: "BACK_TO_LIST", title: "BACK" },
    ]
  );
}

async function sendMyProfilesOverview(to, profiles) {
  if (!profiles.length) {
    await sendText(to, `${WELCOME_MSG}`);
    await sendJoinStopButtons(to);
    return;
  }

  const lines = profiles.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`).join("\n");
  await sendText(
    to,
    `💍 *${BRAND_NAME}*\n\nYour profiles\nआपकी profiles\n\n${lines}\n\nSelect a profile below for DETAILS / DELETE.\nDETAILS / DELETE के लिए नीचे profile चुनिए।`
  );

  await sendList(
    to,
    "Choose your profile\nअपनी profile चुनिए",
    "Select Profile",
    profiles.slice(0, 10).map((p) => ({
      id: `MYPROFILE_${p.profile_id}`,
      title: p.profile_id,
      description: `${p.status || "PENDING"} | ${p.marital_status || "NA"}`,
    })),
    "My Profiles"
  );

  await sendButtons(to, "Quick actions\nजल्दी वाले options", [
    { id: "JOIN", title: "JOIN" },
    { id: "SEARCH", title: "SEARCH" },
    { id: "STOP", title: "STOP" },
  ]);
}

async function sendMyProfileActionButtons(to, profileId) {
  await sendButtons(
    to,
    `Selected Profile: ${profileId}\nचुनी गई profile: ${profileId}`,
    [
      { id: `DETAILS_${profileId}`, title: "DETAILS" },
      { id: `SELF_DELETE_${profileId}`, title: "DELETE" },
      { id: "MYPROFILES", title: "BACK" },
    ]
  );
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
    let effectiveInput = text || interactiveId || "";

if (interactiveId.startsWith("ACCEPT_")) {
  effectiveInput = `ACCEPT ${interactiveId.replace("ACCEPT_", "")}`;
} else if (interactiveId.startsWith("REJECT_")) {
  effectiveInput = `REJECT ${interactiveId.replace("REJECT_", "")}`;
} else if (interactiveId.startsWith("DETAILS_")) {
  effectiveInput = `DETAILS ${interactiveId.replace("DETAILS_", "")}`;
}

const rawInput = effectiveInput;
const { cmd, args } = parseCommand(rawInput);


    // ===================== SHIV SAMADHAN GLOBAL =====================
    if (interactiveId === "SHIV_START_AGAIN") {
      await setState(from, "", {});
      await showMainServiceMenu(from);
      return;
    }

    if (interactiveId === "VIVAHO_HOME") {
      await sendText(from, WELCOME_MSG);
      await sendText(from, COMMANDS_MSG);
      await setState(from, "ONBOARDING_DECISION", {});
      await sendProceedStopButtons(from);
      return;
    }

    if (interactiveId === "SHIV_HOME") {
      await setState(from, "SHIV_INTRO", {});
      await showShivIntro(from);
      return;
    }

    if (interactiveId === "SHIV_PROCEED" && st.step === "SHIV_INTRO") {
      await setState(from, "SHIV_ASK_NAME", {});
      await sendText(from, "अपना पूरा नाम भेजें");
      return;
    }

    if (interactiveId === "SHIV_RESULT_PROCEED") {
      await setState(from, "SHIV_PROBLEM_LIST", temp);
      await showShivProblemList(from);
      return;
    }

    if (interactiveId.startsWith("SHIV_PROB_")) {
      const key = interactiveId.replace("SHIV_PROB_", "");
      const problem = SHIV_PROBLEMS[key] || null;
      if (!problem) {
        await sendText(from, "Problem not found.\nProblem नहीं मिली।");
        return;
      }
      temp.selectedProblem = key;
      await setState(from, "SHIV_PROBLEM_SELECTED", temp);
      await sendButtons(from, problem.emotional, [
        { id: "SHIV_SHOW_SOLUTIONS", title: "समाधान देखें" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (interactiveId === "SHIV_SHOW_SOLUTIONS") {
      await setState(from, "SHIV_PRODUCT_LIST", temp);
      await showShivProducts(from, temp);
      return;
    }

    if (interactiveId.startsWith("SHIV_PRODUCT_")) {
      const productKey = interactiveId.replace("SHIV_PRODUCT_", "");
      await showShivProductDetail(from, productKey, temp);
      return;
    }

    if (interactiveId === "SHIV_BUY_NOW") {
      await setState(from, "SHIV_ADDRESS", temp);
      await sendText(from, "Order process शुरू करने के लिए अपनी delivery details भेजें:\n\nName\nMobile Number\nFull Address\nPincode");
      return;
    }

    if (interactiveId === "SHIV_PAYMENT_DONE") {
      temp.payment_done = true;
      await setState(from, "SHIV_PENDING_ADMIN", temp);
      await sendShivAdminOrder(temp, from);
      await sendText(from, "✅ Payment received request sent to admin.\nअब verification के बाद confirmation भेजा जाएगा।");
      return;
    }

    if (interactiveId.startsWith("SHIV_ADMIN_CONFIRM_") || interactiveId.startsWith("SHIV_ADMIN_REJECT_")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can confirm orders.");
        return;
      }
      const userPhone = normalizePhone(interactiveId.replace("SHIV_ADMIN_CONFIRM_", "").replace("SHIV_ADMIN_REJECT_", ""));
      const userState = await getState(userPhone);
      const userTemp = safeJsonParse(userState.temp_data || "{}", {});
      if (interactiveId.startsWith("SHIV_ADMIN_CONFIRM_")) {
        await setState(userPhone, "", {});
        await sendButtons(
          userPhone,
          `✅ Order Confirmed

👉 आपका order successfully receive हो गया है

📦 Product: ${userTemp.selectedProductTitle || ""}
💰 Price: ₹${userTemp.selectedProductPrice || ""}

👉 आपकी वस्तु आपकी DOB, personal details और problem के अनुसार तैयार की जाएगी

🚚 Delivery: 7–8 days

🌸 आपका भविष्य मंगलमय हो 🌸`,
          [
            { id: "SHIV_START_AGAIN", title: "Start Again" }
          ]
        );
        await sendText(from, `✅ Confirmed order for ${userPhone}`);
      } else {
        await setState(userPhone, "SHIV_PAYMENT", userTemp);
        await sendText(userPhone, "❌ Payment not verified. कृपया payment check करके दोबारा Payment Done दबाएँ या admin से संपर्क करें।");
        await sendText(from, `❌ Marked not confirmed for ${userPhone}`);
      }
      return;
    }

    // ===================== GLOBAL BUTTON / SHORTCUT ACTIONS =====================
    if (interactiveId.startsWith("DEL_PROFILE_") || interactiveId.startsWith("SELF_DELETE_")) {
      const profileId = normalizeProfileId(interactiveId.replace("DEL_PROFILE_", "").replace("SELF_DELETE_", ""));
      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.\nProfile नहीं मिला।");
        return;
      }
      if (prof.phone !== from) {
        await sendText(from, "❌ You can delete only your own profile.\nआप सिर्फ अपनी profile delete कर सकते हैं।");
        return;
      }
      await deleteProfileRow(prof.rowIndex);
      await setState(from, "", {});
      await sendText(from, `✅ Deleted ${profileId}.\n${profileId} delete हो गया।`);
      await sendJoinStopButtons(from, "What would you like to do next?\nअब आगे क्या करना है?");
      return;
    }

    if (interactiveId === "SELF_MORE") {
      await sendButtons(
        from,
        "More actions\nऔर options",
        [
          { id: "JOIN", title: "JOIN" },
          { id: "SEARCH", title: "SEARCH" },
          { id: "MYPROFILES", title: "MYPROFILES" },
        ]
      );
      return;
    }

    if (interactiveId.startsWith("ADMIN_APPROVE_") || interactiveId.startsWith("ADMIN_REJECT_")) {
      if (!isAdmin(from)) {
        await sendText(from, "❌ Only admin can approve/reject profiles.");
        return;
      }

      const profileId = normalizeProfileId(
        interactiveId.replace("ADMIN_APPROVE_", "").replace("ADMIN_REJECT_", "")
      );
      const prof = await findProfileById(profileId);
      if (!prof) {
        await sendText(from, "Profile ID not found.");
        return;
      }

      const newStatus = interactiveId.startsWith("ADMIN_APPROVE_") ? "APPROVED" : "REJECTED";
      await updateProfileStatus(prof.rowIndex, newStatus);

      if (newStatus === "APPROVED") {
        await sendText(
          prof.phone,
          `🎉 Congratulations! Your profile *${profileId}* is now *APPROVED*.\nबधाई हो! आपकी profile *${profileId}* अब *APPROVED* है।\n\n💍 *${BRAND_NAME}*\n${BRAND_TAGLINE}`
        );
        await sendButtons(prof.phone, "You can start searching now.\nअब आप search शुरू कर सकते हैं।", [
          { id: "SEARCH", title: "SEARCH" },
          { id: "MYPROFILES", title: "MYPROFILES" },
        ]);
        await sendText(from, `✅ Approved ${profileId}`);
      } else {
        await sendText(
          prof.phone,
          `❌ Your profile *${profileId}* was rejected.\nआपकी profile *${profileId}* reject कर दी गई है。\n\nYou can delete it and create a new one.\nआप इसे delete करके नई profile बना सकते हैं।`
        );
        await sendButtons(prof.phone, "Next step\nअगला step", [
          { id: "MYPROFILES", title: "MYPROFILES" },
          { id: `SELF_DELETE_${profileId}`, title: "DELETE" },
        ]);
        await sendText(from, `✅ Rejected ${profileId}`);
      }
      return;
    }

    if (interactiveId.startsWith("SELECT_RESULT_")) {
      const profileId = normalizeProfileId(interactiveId.replace("SELECT_RESULT_", ""));
      temp.search = temp.search || {};
      temp.search.selectedProfileId = profileId;
      await setState(from, "SEARCH_SELECTED_ACTIONS", temp);
      await sendSelectedResultActions(from, profileId);
      return;
    }

    if (interactiveId.startsWith("MYPROFILE_")) {
      const profileId = normalizeProfileId(interactiveId.replace("MYPROFILE_", ""));
      temp.myprofiles = temp.myprofiles || {};
      temp.myprofiles.selectedProfileId = profileId;
      await setState(from, "MYPROFILE_ACTIONS", temp);
      await sendMyProfileActionButtons(from, profileId);
      return;
    }

    if (interactiveId.startsWith("DETAILS_")) {
      const profileId = normalizeProfileId(interactiveId.replace("DETAILS_", ""));
      temp.pendingDirectAction = null;
      await setState(from, st.step, temp);
      // fall through by emulating DETAILS command
      const target = `DETAILS ${profileId}`;
      const parsed = parseCommand(target);
      await handleDirectCommand(parsed.cmd, parsed.args);
      return;
    }

    if (interactiveId.startsWith("INTEREST_")) {
      const profileId = normalizeProfileId(interactiveId.replace("INTEREST_", ""));
      const target = `INTEREST ${profileId}`;
      const parsed = parseCommand(target);
      await handleDirectCommand(parsed.cmd, parsed.args);
      return;
    }

    if (interactiveId === "BACK_TO_LIST") {
      if (temp.search && Array.isArray(temp.search.results) && temp.search.results.length) {
        await setState(from, "SEARCH_RESULTS", temp);
        await sendResultsPage(from, temp.search);
        return;
      }
      if (temp.myprofiles) {
        const profiles = await findProfilesByPhone(from);
        await setState(from, "MYPROFILE_ACTIONS", temp);
        await sendMyProfilesOverview(from, profiles);
        return;
      }
      await sendText(from, "Nothing to go back to.\nवापस जाने के लिए कुछ नहीं है।");
      return;
    }

    // ===================== GLOBAL CANCEL =====================
    if (cmd === "STOP" || cmd === "CANCEL") {
      await setState(from, "", {});
      await sendText(from, "✅ Process बंद कर दिया गया है।\nकृपया अपनी सेवा चुनें।");
      await showMainServiceMenu(from);
      return;
    }

    // helper to reuse command blocks from interactive shortcuts
    async function handleDirectCommand(command, commandArgs) {
      // ===================== ADMIN COMMANDS =====================
      if (command && (command === "APPROVE" || command === "REJECT")) {
        if (!isAdmin(from)) {
          await sendText(from, "❌ Only admin can approve/reject profiles.");
          return;
        }

        const profileId = normalizeProfileId(commandArgs[0]);
        if (!profileId) {
          await sendText(from, "Use: approve MH-XXXX  OR  reject MH-XXXX");
          return;
        }

        const prof = await findProfileById(profileId);
        if (!prof) {
          await sendText(from, "Profile ID not found.");
          return;
        }

        const newStatus = command === "APPROVE" ? "APPROVED" : "REJECTED";
        await updateProfileStatus(prof.rowIndex, newStatus);

        if (command === "APPROVE") {
          await sendText(
            prof.phone,
            `🎉 Congratulations! Your profile *${profileId}* is now *APPROVED*.\nबधाई हो! आपकी profile *${profileId}* अब *APPROVED* है।\n\n💍 *${BRAND_NAME}*\n${BRAND_TAGLINE}`
          );
          await sendButtons(prof.phone, "You can start searching now.\nअब आप search शुरू कर सकते हैं।", [
            { id: "SEARCH", title: "SEARCH" },
            { id: "MYPROFILES", title: "MYPROFILES" },
          ]);
          await sendText(from, `✅ Approved ${profileId}`);
        } else {
          await sendText(
            prof.phone,
            `❌ Your profile *${profileId}* was rejected.\nआपकी profile *${profileId}* reject कर दी गई है।\n\nYou can delete it and create a new one.\nआप इसे delete करके नई profile बना सकते हैं।`
          );
          await sendButtons(prof.phone, "Next step\nअगला step", [
            { id: "MYPROFILES", title: "MYPROFILES" },
            { id: `SELF_DELETE_${profileId}`, title: "DELETE" },
          ]);
          await sendText(from, `✅ Rejected ${profileId}`);
        }
        return;
      }

      // ===================== MYPROFILES =====================
      if (command === "MYPROFILES") {
        const profiles = await findProfilesByPhone(from);
        temp.myprofiles = temp.myprofiles || {};
        await setState(from, "MYPROFILE_ACTIONS", temp);
        await sendMyProfilesOverview(from, profiles);
        return;
      }

      // ===================== DELETE =====================
      if (command === "DELETE") {
        const profileId = normalizeProfileId(commandArgs[0]);
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
        await sendText(from, `✅ Deleted ${profileId}.\n${profileId} delete हो गया।`);
        await sendJoinStopButtons(from, "What would you like to do next?\nअब आगे क्या करना है?");
        return;
      }

      // ===================== MATCHES / SEARCH =====================
      if (command === "MATCHES" || command === "SEARCH") {
        const profiles = await findProfilesByPhone(from);

        if (!profiles.length) {
          await sendText(from, `${WELCOME_MSG}`);
          await sendJoinStopButtons(from, "No profile found.\nकोई profile नहीं मिली।");
          return;
        }

        const active = getLatestApprovedProfile(profiles);
        if (!active) {
          await sendText(from, PENDING_MSG);
         const latest = profiles[0];

await sendButtons(
  from,
  "आपका profile approval के लिए pending है",
  [
    { id: "SEARCH", title: "SEARCH" },
    { id: `DETAILS_${latest.profile_id}`, title: "DETAILS" },
    { id: `DELETE_${latest.profile_id}`, title: "DELETE" },
  ]
);
          return;
        }

        const targetGender = oppositeGender(active.gender);
        if (!targetGender) {
          await sendText(from, "Gender missing in profile.\nProfile में gender missing है। कृपया नई profile बनाइए।");
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
          maritalStatus: null,
          casteScope: null,
          eduMinRank: null,
          incomeMinRank: null,
          results: [],
          page: 0,
          selectedProfileId: "",
        };

        await setState(from, "SEARCH_CITY_SCOPE", temp);
        await sendButtons(from, "Native place preference\nNative place के लिए preference चुनें", [
          { id: "SEARCH_NATIVE_SAME", title: "Same Native" },
          { id: "SEARCH_NATIVE_ANY", title: "Any Native" },
        ]);
        return;
      }

      // ===================== NEXT / PREV =====================
      if (command === "NEXT" || command === "PREV") {
        if (!temp.search || !Array.isArray(temp.search.results)) {
          await sendText(from, "Tap *SEARCH* to start.\nSearch शुरू करने के लिए *SEARCH* tap कीजिए।");
          return;
        }

        const total = temp.search.results.length;
        if (!total) {
          await sendSearchAgainButton(from);
          return;
        }

        const maxPage = Math.floor((total - 1) / RESULTS_PAGE_SIZE);
        let page = temp.search.page || 0;
        page = command === "NEXT" ? Math.min(maxPage, page + 1) : Math.max(0, page - 1);
        temp.search.page = page;

        await setState(from, "SEARCH_RESULTS", temp);
        await sendResultsPage(from, temp.search);
        return;
      }

      // ===================== DETAILS =====================
      if (command === "DETAILS") {
        const profileId = normalizeProfileId(commandArgs[0]);
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
          await sendSearchButton(from, "Approval के बाद search शुरू कीजिए।");
          return;
        }

        const target = await findProfileById(profileId);
        if (!target || cleanUpper(target.status) !== "APPROVED") {
          if (target && target.phone === from) {
            // allow own profile details even if not approved? keep current logic strict for search/details access
          }
          await sendText(from, "Profile not found / not approved.\nProfile नहीं मिली या अभी approved नहीं है।");
          return;
        }

        const isOwnProfile = target.phone === from;

        if (!isOwnProfile) {
          const used = await countThisMonth({ from_profile_id: active.profile_id, type: "DETAILS" });
          if (used >= MAX_DETAILS_PER_MONTH) {
            await sendText(from, `⚠️ Monthly limit reached.\nMaximum ${MAX_DETAILS_PER_MONTH} details per month.`);
            return;
          }

          await appendRequest({
            from_profile_id: active.profile_id,
            to_profile_id: target.profile_id,
            status: "SENT",
            type: "DETAILS",
            viewer_phone: from,
          });
        }

        const age = calcAgeFromDobDDMMYYYY(target.date_of_birth);
        const cap =
`💍 *${BRAND_NAME}*

📄 Profile Details
प्रोफाइल जानकारी

ID: ${target.profile_id}
Gender: ${target.gender}
Marital Status: ${target.marital_status || "NA"}
Age: ${age !== null ? age : "NA"}

Native: ${target.native_place || "NA"}, ${target.district || "NA"}
Work: ${target.work_city || "NA"}, ${target.work_district || "NA"}

Religion: ${target.religion || "NA"}
Caste: ${target.caste || "NA"}
Height: ${target.height || "NA"}

Education: ${target.education || "NA"}
Job Type: ${target.job || "NA"}
Job Title: ${target.job_title || "NA"}
Income: ${target.income_annual || "NA"}

${isOwnProfile ? "यह आपकी अपनी profile है।" : `If interested: INTEREST ${target.profile_id}\nInterest भेजने के लिए: INTEREST ${target.profile_id}`}`;

        if (target.photo_url) {
          await sendImageByLink(from, target.photo_url, cap);
        } else {
          await sendText(from, cap + "\n\n(No photo available)");
        }

        if (isOwnProfile) {
          temp.selfDetailsProfileId = target.profile_id;
          await setState(from, "SELF_PROFILE_DETAILS", temp);
          await sendSelfProfileActionButtons(from, target.profile_id);
        } else {
          temp.search = temp.search || {};
          temp.search.selectedProfileId = target.profile_id;
          await setState(from, "SEARCH_SELECTED_ACTIONS", temp);
          await sendButtons(from, "Next action\nआगे क्या करना है?", [
            { id: `INTEREST_${target.profile_id}`, title: "INTEREST" },
            { id: "SEARCH", title: "Search Again" },
            { id: "BACK_TO_LIST", title: "BACK" },
          ]);
        }
        return;
      }

      // ===================== INTEREST =====================
      if (command === "INTEREST") {
        const profileId = normalizeProfileId(commandArgs[0]);
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
          await sendText(from, "❌ You cannot send INTEREST to your own profile.\nआप अपनी profile पर interest नहीं भेज सकते।");
          return;
        }

        const used = await countThisMonth({ from_profile_id: active.profile_id, type: "INTEREST" });
        if (used >= MAX_INTEREST_PER_MONTH) {
          await sendText(from, `⚠️ Monthly limit reached.\nMaximum ${MAX_INTEREST_PER_MONTH} interests per month.`);
          return;
        }

        const target = await findProfileById(profileId);
        if (!target || cleanUpper(target.status) !== "APPROVED") {
          await sendText(from, "Profile not found / not approved.\nProfile नहीं मिली या approved नहीं है।");
          return;
        }

        const existing = await findInterestRequest({
          from_profile_id: active.profile_id,
          to_profile_id: target.profile_id,
        });

        if (existing && ["SENT", "ACCEPTED"].includes(existing.status)) {
          await sendText(from, "You already showed interest in this profile.\nआप पहले ही इस profile पर interest भेज चुके हैं।");
          return;
        }

        await appendRequest({
          from_profile_id: active.profile_id,
          to_profile_id: target.profile_id,
          status: "SENT",
          type: "INTEREST",
          viewer_phone: from,
        });

        await sendButtons(
  target.phone,
  `💌 *${BRAND_NAME}*

Someone showed interest in you.
किसी ने आपके profile में interest दिखाया है।

Interested Profile ID: *${active.profile_id}*

Choose an option
कृपया एक विकल्प चुनें`,
  [
    { id: `ACCEPT_${active.profile_id}`, title: "ACCEPT" },
    { id: `REJECT_${active.profile_id}`, title: "REJECT" },
    { id: `DETAILS_${active.profile_id}`, title: "DETAILS" },
  ]
);

        await sendText(from, `✅ Interest sent to ${target.profile_id}.\nInterest भेज दिया गया है।`);
        if (temp.search && Array.isArray(temp.search.results) && temp.search.results.length) {
          await sendButtons(from, "Next action\nआगे क्या करना है?", [
            { id: "SEARCH", title: "Search Again" },
            { id: "BACK_TO_LIST", title: "BACK" },
          ]);
        }
        return;
      }

      // ===================== ACCEPT / REJECT =====================
      if (command === "ACCEPT" || command === "REJECT") {
        const interestedProfileId = normalizeProfileId(commandArgs[0]);
        if (!interestedProfileId) {
          await sendText(from, "Use: ACCEPT MH-XXXX  OR  REJECT MH-XXXX");
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
          await sendText(from, "No pending interest found for this Profile ID.\nइस Profile ID के लिए pending interest नहीं मिली।");
          return;
        }

        const newStatus = command === "ACCEPT" ? "ACCEPTED" : "REJECTED";
        await updateRequestStatus(foundReq.rowIndex, newStatus);

        const senderProfile = await findProfileById(interestedProfileId);
        if (!senderProfile) {
          await sendText(from, "Interest processed, but sender profile not found.");
          return;
        }

        if (command === "REJECT") {
          await sendText(from, `❌ Rejected interest from ${interestedProfileId}.\nInterest reject कर दी गई।`);
          await sendText(senderProfile.phone, `❌ Your interest was rejected by ${receiverActive.profile_id}.\nआपका interest reject कर दिया गया है।`);
          return;
        }

        await sendText(from, `✅ Accepted interest from ${interestedProfileId}.\nInterest accept कर लिया गया है।`);
        await sendText(from, `📞 Contact shared:\nProfile: ${interestedProfileId}\nPhone: ${senderProfile.phone}`);
        await sendText(
          senderProfile.phone,
          `✅ Your interest was accepted!\nआपका interest accept हो गया है!\n\n📞 Contact shared:\nProfile: ${receiverActive.profile_id}\nPhone: ${receiverActive.phone}`
        );
        return;
      }
    }

    if (rawInput && ["APPROVE","REJECT","MYPROFILES","DELETE","MATCHES","SEARCH","NEXT","PREV","DETAILS","INTEREST","ACCEPT","REJECT"].includes(cmd)) {
      await handleDirectCommand(cmd, args);
      return;
    }

    // ===================== RESULTS INVALID REPLY PROTECTION =====================
    if (st.step === "SEARCH_RESULTS") {
      const valid =
        cmd === "NEXT" ||
        cmd === "PREV" ||
        cmd === "DETAILS" ||
        cmd === "INTEREST" ||
        isValidProfileId(rawInput) ||
        interactiveId.startsWith("SELECT_RESULT_") ||
        cmd === "SEARCH";
      if (!valid) {
        await sendText(
          from,
          "❌ Invalid response.\n\nPlease tap a profile from the list or send one of these:\n*NEXT*\n*PREV*\n*DETAILS MH-XXXX*\n*INTEREST MH-XXXX*\n*SEARCH*\n\nOr type *STOP*."
        );
        return;
      }
      if (isValidProfileId(rawInput)) {
        temp.search = temp.search || {};
        temp.search.selectedProfileId = normalizeProfileId(rawInput);
        await setState(from, "SEARCH_SELECTED_ACTIONS", temp);
        await sendSelectedResultActions(from, normalizeProfileId(rawInput));
        return;
      }
    }

    // ===================== ONBOARDING DECISION =====================
    if (st.step === "ONBOARDING_DECISION") {
      if (interactiveId === "PROCEED" || cmd === "JOIN" || cmd === "PROCEED") {

  const existing = await findProfilesByPhone(from);

  if (existing.length >= MAX_PROFILES_PER_PHONE) {
  const latest = existing[0];
  const lines = existing.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`).join("\n");

  await sendText(
    from,
    `⚠️ You already have ${existing.length} profile (max ${MAX_PROFILES_PER_PHONE}).

${lines}

Choose what you want to do next:
आगे क्या करना है, नीचे चुनें।`
  );

  await sendButtons(
    from,
    `Profile: ${latest.profile_id}`,
    [
      { id: `DELETE_${latest.profile_id}`, title: "DELETE" },
      { id: `DETAILS_${latest.profile_id}`, title: "DETAILS" },
      { id: "SEARCH", title: "SEARCH" },
    ]
  );

  return;
}

  await setState(from, "ASK_NAME", {});
  await sendText(from, getPromptByStep("ASK_NAME"));
  return;
}

      if (interactiveId === "STOP" || cmd === "STOP") {
        await setState(from, "", {});
        await showMainServiceMenu(from);
        return;
      }

      if (cmd === "SEARCH") {
        await handleDirectCommand("SEARCH", []);
        return;
      }

      await sendText(from, makeInvalidReplyMsg("Please choose Proceed or Stop."));
      await sendProceedStopButtons(from);
      return;
    }

    // ===================== REGISTRATION START =====================
    if (rawInput && (cmd === "JOIN" || cmd === "NEWPROFILE")) {
      const existing = await findProfilesByPhone(from);

     if (existing.length >= MAX_PROFILES_PER_PHONE) {
  const latest = existing[0];
  const lines = existing.map((p) => `• ${p.profile_id} (${p.status || "PENDING"})`).join("\n");

  await sendText(
    from,
    `⚠️ You already have ${existing.length} profile (max ${MAX_PROFILES_PER_PHONE}).
आपके पास पहले से ${existing.length} profile है (max ${MAX_PROFILES_PER_PHONE}).

${lines}

Choose what you want to do next:
आगे क्या करना है, नीचे चुनें।`
  );

  await sendButtons(
    from,
    `Profile: ${latest.profile_id}`,
    [
      { id: `SELF_DELETE_${latest.profile_id}`, title: "DELETE" },
      { id: `DETAILS_${latest.profile_id}`, title: "DETAILS" },
      { id: "SEARCH", title: "SEARCH" },
    ]
  );

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
        await showMainServiceMenu(from);
      }
      return;
    }


    // ===================== SHIV SAMADHAN STATES =====================
    if (st.step === "SHIV_INTRO") {
      if (cmd === "PROCEED") {
        await setState(from, "SHIV_ASK_NAME", temp);
        await sendText(from, "अपना पूरा नाम भेजें");
        return;
      }
      await showShivIntro(from);
      return;
    }

    if (st.step === "SHIV_ASK_NAME") {
      if (!rawInput || rawInput.length < 2) {
        await sendText(from, "कृपया अपना सही नाम भेजें।");
        return;
      }
      temp.name = rawInput;
      await setState(from, "SHIV_ASK_DOB", temp);
      await sendText(from, "अपनी Date of Birth भेजें\nFormat: DD-MM-YYYY");
      return;
    }

    if (st.step === "SHIV_ASK_DOB") {
      if (!/^\d{2}-\d{2}-\d{4}$/.test(rawInput || "")) {
        await sendText(from, "गलत format. कृपया DD-MM-YYYY में DOB भेजें।");
        return;
      }
      temp.dob = rawInput;
      await setState(from, "SHIV_ASK_BIRTH_TIME", temp);
      await sendButtons(from, "अपना Birth Time भेजें\nExample: 09:25 AM\n\nअगर exact time नहीं पता, तो SKIP करें।", [
        { id: "SHIV_SKIP_TIME", title: "SKIP" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_ASK_BIRTH_TIME") {
      if (interactiveId === "SHIV_SKIP_TIME" || cmd === "SKIP") {
        temp.birth_time = "SKIP";
      } else if (!rawInput) {
        await sendText(from, "कृपया Birth Time भेजें या SKIP करें।");
        return;
      } else {
        temp.birth_time = rawInput;
      }
      await setState(from, "SHIV_ASK_BIRTH_PLACE", temp);
      await sendButtons(from, `अपना Birth Place भेजें
अगर पता न हो तो Skip करें`, [
        { id: "SHIV_SKIP_PLACE", title: "SKIP" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_ASK_BIRTH_PLACE") {
      if (interactiveId === "SHIV_SKIP_PLACE" || cmd === "SKIP") {
        temp.birth_place = "SKIP";
      } else if (!rawInput || rawInput.length < 2) {
        await sendText(from, "कृपया सही Birth Place भेजें या Skip करें।");
        return;
      } else {
        temp.birth_place = rawInput;
      }
      const reading = await getShivReading(temp);
      temp.reading = reading;
      await setState(from, "SHIV_RESULT", temp);
      await sendButtons(from, buildShivResultMessage(temp, reading), [
        { id: "SHIV_RESULT_PROCEED", title: "Proceed" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_RESULT") {
      await sendButtons(from, buildShivResultMessage(temp, temp.reading || {}), [
        { id: "SHIV_RESULT_PROCEED", title: "Proceed" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_PROBLEM_LIST") {
      await showShivProblemList(from);
      return;
    }

    if (st.step === "SHIV_PROBLEM_SELECTED") {
      const problem = SHIV_PROBLEMS[temp.selectedProblem] || null;
      if (!problem) {
        await showShivProblemList(from);
        return;
      }
      await sendButtons(from, problem.emotional, [
        { id: "SHIV_SHOW_SOLUTIONS", title: "समाधान देखें" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_PRODUCT_LIST") {
      await showShivProducts(from, temp);
      return;
    }

    if (st.step === "SHIV_PRODUCT_DETAIL") {
      if (!temp.selectedProduct) {
        await showShivProducts(from, temp);
        return;
      }
      await showShivProductDetail(from, temp.selectedProduct, temp);
      return;
    }

    if (st.step === "SHIV_ADDRESS") {
      if (!rawInput || rawInput.length < 10) {
        await sendText(from, "कृपया पूरा delivery address भेजें।");
        return;
      }
      temp.delivery_details = rawInput;
      await setState(from, "SHIV_PAYMENT", temp);
      await sendText(
        from,
        `👉 Order confirm करने के लिए
नीचे दिए गए QR पर payment करें...${SHIV_UPI_ID ? `
UPI: ${SHIV_UPI_ID}` : ""}`
      );
      if (SHIV_QR_IMAGE_URL) {
        try {
          await sendImageByLink(from, SHIV_QR_IMAGE_URL, "Scan & Pay");
        } catch (e) {
          console.error("Shiv QR send failed:", e?.response?.data || e.message);
        }
      }
      await sendButtons(from, "Payment complete होने के बाद नीचे क्लिक करें", [
        { id: "SHIV_PAYMENT_DONE", title: "Payment Done" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_PAYMENT") {
      await sendText(
        from,
        `👉 Order confirm करने के लिए
नीचे दिए गए QR पर payment करें...${SHIV_UPI_ID ? `
UPI: ${SHIV_UPI_ID}` : ""}`
      );
      if (SHIV_QR_IMAGE_URL) {
        try {
          await sendImageByLink(from, SHIV_QR_IMAGE_URL, "Scan & Pay");
        } catch (e) {
          console.error("Shiv QR send failed:", e?.response?.data || e.message);
        }
      }
      await sendButtons(from, "Payment complete होने के बाद नीचे क्लिक करें", [
        { id: "SHIV_PAYMENT_DONE", title: "Payment Done" },
        { id: "SHIV_START_AGAIN", title: "Start Again" },
      ]);
      return;
    }

    if (st.step === "SHIV_PENDING_ADMIN") {
      await sendText(from, "Payment verification pending. कृपया admin confirmation का wait करें।");
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
      await sendButtons(from, "Age range preference\nउम्र की preference चुनिए", [
        { id: "AGE_SKIP", title: "SKIP" },
      ]);
      await sendText(from, getPromptByStep("SEARCH_AGE_RANGE"));
      return;
    }

    if (st.step === "SEARCH_AGE_RANGE") {
      if (!rawInput) return;

      if (interactiveId === "AGE_SKIP" || isSkip(rawInput)) {
        temp.search.ageMin = 21;
        temp.search.ageMax = 40;
      } else {
        const m = rawInput.match(/^(\d{2})-(\d{2})$/);
        if (!m) {
          await sendText(from, makeInvalidReplyMsg(getPromptByStep("SEARCH_AGE_RANGE")));
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

      await setState(from, "SEARCH_MARITAL_STATUS", temp);
      await sendList(
        from,
        "Marital status preference\nआप किस marital status का match चाहते हैं?",
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
      else ms = maritalStatusFromInput(rawInput);

      if (!ms) {
        await sendText(from, "Please select marital status preference.\nMarital status preference चुनिए।");
        await sendList(
          from,
          "Marital status preference\nआप किस marital status का match चाहते हैं?",
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

      temp.search.maritalStatus = ms;
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
      let edu = "";
      if (interactiveId === "EDU_ANY") edu = "ANY";
      else if (interactiveId === "EDU_GRAD") edu = "GRADUATE";
      else if (interactiveId === "EDU_POST") edu = "POSTGRADUATE";
      else edu = normalizeEducationInput(rawInput);

      if (!edu) {
        await sendText(from, makeInvalidReplyMsg("Please choose education preference."));
        await sendButtons(from, "Minimum education\nMinimum education चुनें", [
          { id: "EDU_ANY", title: "Any" },
          { id: "EDU_GRAD", title: "Graduate" },
          { id: "EDU_POST", title: "Postgrad" },
        ]);
        return;
      }

      if (edu === "ANY") temp.search.eduMinRank = null;
      else if (edu === "GRADUATE") temp.search.eduMinRank = 2;
      else if (edu === "POSTGRADUATE") temp.search.eduMinRank = 3;

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
        await sendText(from, "Please select an income range.\nIncome range चुनिए।");
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
        maritalStatus: temp.search.maritalStatus,
        casteScope: temp.search.casteScope,
        userCaste: temp.search.user_caste,
        eduMinRank: temp.search.eduMinRank,
        incomeMinRank: temp.search.incomeMinRank,
      });

      temp.search.results = results;
      temp.search.page = 0;
      temp.search.selectedProfileId = "";

      await setState(from, "SEARCH_RESULTS", temp);
      await sendResultsPage(from, temp.search);
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
        "Your Marital Status\nतुमची वैवाहिक स्थिती",
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

      if (!ms || ms === "ANY") {
        await sendText(from, "Please select marital status.\nMarital status चुनिए।");
        await sendList(
          from,
          "Your Marital Status\nतुमची वैवाहिक स्थिती",
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
        await sendText(from, `❌ Registration not allowed.\nMinimum age is ${MIN_AGE}.`);
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
        await sendText(from, "Please select job type.\nJob type चुनिए।");
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
        await sendText(from, "Please select income range.\nIncome range चुनिए।");
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
        await sendText(from, "Photo not received properly. Please send again.\nPhoto सही से नहीं मिली, फिर से भेजिए।");
        return;
      }

      const metaUrl = await getMetaMediaUrl(mediaId);
      if (!metaUrl) {
        await sendText(from, "Could not read photo. Please send again.\nPhoto पढ़ी नहीं जा सकी, फिर से भेजिए।");
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
        await sendText(from, "Photo upload failed. Please send photo again later.\nPhoto upload नहीं हुई। थोड़ी देर बाद फिर से भेजिए।");
        return;
      }

      temp.photo_url = permanentLink;

      const profileId = await createProfile(from, temp);
      await notifyAdminNewProfile(profileId, from, temp);

      await setState(from, "", {});
      await sendText(
        from,
        `✅ Registration completed!\nRegistration पूरी हो गई है।\n\nYour Profile ID: *${profileId}*\nआपकी Profile ID: *${profileId}*\n\n💍 *${BRAND_NAME}*\n${BRAND_TAGLINE}\n\nStatus: *PENDING approval*\nApproval pending hai.\n\nYou will receive a message after approval.\nApproval के बाद आपको message मिलेगा।`
      );
      await sendButtons(from, "Next action\nआगे क्या करना है?", [
        { id: "MYPROFILES", title: "MYPROFILES" },
        { id: "JOIN", title: "JOIN" },
      ]);
      return;
    }

    // ===================== SEARCH SELECTED ACTIONS INVALID =====================
    if (st.step === "SEARCH_SELECTED_ACTIONS") {
      if (interactiveId === "BACK_TO_LIST") {
        await setState(from, "SEARCH_RESULTS", temp);
        await sendResultsPage(from, temp.search || {});
        return;
      }
      await sendText(from, "Please tap DETAILS / INTEREST / BACK.\nकृपया DETAILS / INTEREST / BACK tap कीजिए।");
      return;
    }

    if (st.step === "MYPROFILE_ACTIONS") {
      await sendText(from, "Please choose from MYPROFILES list or buttons.\nकृपया MYPROFILES list या buttons में से चुनिए।");
      return;
    }

    if (st.step === "SELF_PROFILE_DETAILS") {
      await sendText(from, "Please use the buttons below.\nकृपया नीचे दिए गए buttons use कीजिए।");
      await sendSelfProfileActionButtons(from, temp.selfDetailsProfileId || "");
      return;
    }
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message || err);
  }
});

// ===================== Start Server =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
