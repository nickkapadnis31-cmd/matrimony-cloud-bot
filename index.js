
VIVAHO BOT FINAL MODIFICATIONS (BILINGUAL VERSION)
=================================================

IMPORTANT:
-----------
Keep all customer-facing messages bilingual exactly like old code:
- English first
- Hindi second

Examples:
---------
"Profile created successfully.
प्रोफाइल सफलतापूर्वक बनाई गई।"

"Choose option
कृपया विकल्प चुनें"

--------------------------------------------------
1. MAX PROFILE LIMIT
--------------------------------------------------

const MAX_PROFILES_PER_PHONE = 1;

--------------------------------------------------
2. GOOGLE SHEET NEW STRUCTURE
--------------------------------------------------

A profile_id
B phone
C name
D surname
E gender
F date_of_birth
G religion
H height
I caste
J native_place
K district
L work_city
M work_district
N education
O job
P job_title
Q income_annual
R photo_url
S status
T approved_1_expiry
U approved_2
V approved_2_expiry
W created_at
X marital_status

--------------------------------------------------
3. UPDATE PROFILE RANGE
--------------------------------------------------

CHANGE:

range: `${PROFILE_TAB}!A:U`

TO:

range: `${PROFILE_TAB}!A:X`

--------------------------------------------------
4. REMOVE SHIV SAMADHAN COMPLETELY
--------------------------------------------------

DELETE:
- SHIV constants
- SHIV_PRODUCTS
- SHIV_PROBLEMS
- astrology APIs
- numerology logic
- SHIV states
- SHIV buttons
- SHIV flows
- SHIV admin handlers

--------------------------------------------------
5. NEW WELCOME BUTTONS
--------------------------------------------------

await sendButtons(
  from,
  WELCOME_MSG,
  [
    { id: "JOIN", title: "JOIN" },
    { id: "SEARCH", title: "SEARCH" },
    { id: "STOP", title: "STOP" }
  ]
);

--------------------------------------------------
6. ANYONE CAN SEARCH
--------------------------------------------------

REMOVE:
- approved-only restriction
- approved profile validation before search

SEARCH SHOULD WORK FOR:
- pending users
- approved users
- users without profile

--------------------------------------------------
7. SEARCH SHOULD SHOW PENDING + APPROVED
--------------------------------------------------

REPLACE:

if (cleanUpper(p.status) !== "APPROVED") continue;

WITH:

if (![ "APPROVED", "PENDING" ].includes(cleanUpper(p.status))) continue;

--------------------------------------------------
8. NEW SEARCH FLOW
--------------------------------------------------

NEW FLOW:
---------
Bride/Groom selection
↓
Single profile with photo
↓
Buttons:
- SELECT
- FILTER SEARCH
- NEXT

--------------------------------------------------
9. SEARCH START BUTTONS
--------------------------------------------------

await sendButtons(
  from,
  "What are you looking for?\nआप क्या खोज रहे हैं?",
  [
    { id: "SEARCH_BRIDE", title: "Bride" },
    { id: "SEARCH_GROOM", title: "Groom" },
    { id: "STOP", title: "STOP" }
  ]
);

--------------------------------------------------
10. NEW SINGLE PROFILE SEARCH FUNCTION
--------------------------------------------------

async function sendSingleSearchResult(to, results, index = 0) {

  if (!results.length) {

    await sendButtons(
      to,
      "No profiles found.\nकोई प्रोफाइल नहीं मिला।",
      [
        { id: "SEARCH", title: "SEARCH" }
      ]
    );

    return;
  }

  const p = results[index];

  const age = calcAgeFromDobDDMMYYYY(p.date_of_birth);

  const caption =
`💍 ${p.profile_id}

Age: ${age || "NA"}
उम्र: ${age || "NA"}

Gender: ${p.gender}

Marital: ${p.marital_status || "NA"}

Native: ${p.native_place || "NA"}

Work City: ${p.work_city || "NA"}

Education: ${p.education || "NA"}

Job: ${p.job_title || p.job || "NA"}

Status: ${p.status}`;

  if (p.photo_url) {
    await sendImageByLink(to, p.photo_url, caption);
  } else {
    await sendText(to, caption);
  }

  await sendButtons(
    to,
    "Choose option\nकृपया विकल्प चुनें",
    [
      {
        id: `SELECT_${p.profile_id}`,
        title: "SELECT"
      },
      {
        id: "SEARCH",
        title: "FILTER"
      },
      {
        id: `NEXT_${index}`,
        title: "NEXT"
      }
    ]
  );
}

--------------------------------------------------
11. NEXT BUTTON HANDLER
--------------------------------------------------

if (interactiveId.startsWith("NEXT_")) {

  const idx = parseInt(
    interactiveId.replace("NEXT_", "")
  );

  temp.searchIndex = idx + 1;

  if (temp.searchIndex >= temp.searchResults.length) {
    temp.searchIndex = 0;
  }

  await setState(from, st.step, temp);

  await sendSingleSearchResult(
    from,
    temp.searchResults,
    temp.searchIndex
  );

  return;
}

--------------------------------------------------
12. SELECT BUTTON HANDLER
--------------------------------------------------

if (interactiveId.startsWith("SELECT_")) {

  const profileId = interactiveId.replace(
    "SELECT_",
    ""
  );

  await sendButtons(
    from,
    `Selected ${profileId}
चुनी गई प्रोफाइल ${profileId}`,
    [
      {
        id: `DETAILS_${profileId}`,
        title: "DETAILS"
      },
      {
        id: `INTEREST_${profileId}`,
        title: "INTEREST"
      },
      {
        id: "SEARCH",
        title: "BACK"
      }
    ]
  );

  return;
}

--------------------------------------------------
13. PAYMENT MESSAGE AFTER PROFILE CREATION
--------------------------------------------------

await sendButtons(
  from,
  `🎉 Profile created successfully.
प्रोफाइल सफलतापूर्वक बनाई गई।

💳 Choose membership plan:

₹300 → 3 Months
₹1000 → 1 Year
₹2000 → Premium Both

Payment करके screenshot admin को भेजें।`,
  [
    {
      id: "MAKE_PAYMENT",
      title: "PAYMENT"
    },
    {
      id: "SEARCH",
      title: "SEARCH"
    },
    {
      id: "START_AGAIN",
      title: "START"
    }
  ]
);

--------------------------------------------------
14. ADMIN BUTTONS
--------------------------------------------------

await sendButtons(
  ADMIN_PHONE,
  `Action for ${profileId}`,
  [
    {
      id: `ADMIN_APPROVE1_3_${profileId}`,
      title: "A1-3MO"
    },
    {
      id: `ADMIN_APPROVE1_Y_${profileId}`,
      title: "A1-1YR"
    },
    {
      id: `ADMIN_APPROVE2_${profileId}`,
      title: "APPROVE2"
    }
  ]
);

await sendButtons(
  ADMIN_PHONE,
  "Reject option\nReject करने के लिए नीचे क्लिक करें",
  [
    {
      id: `ADMIN_REJECT_${profileId}`,
      title: "REJECT"
    }
  ]
);

--------------------------------------------------
15. APPROVAL UPDATE FUNCTIONS
--------------------------------------------------

function addMonths(date, months) {

  const d = new Date(date);

  d.setMonth(d.getMonth() + months);

  return d.toISOString();
}

--------------------------------------------------

async function updateProfileApproval1(
  rowIndex,
  expiry
) {

  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!S${rowIndex}:T${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[ "APPROVED", expiry ]]
    }
  });
}

--------------------------------------------------

async function updateProfileApproval2(
  rowIndex,
  expiry
) {

  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${PROFILE_TAB}!S${rowIndex}:V${rowIndex}`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[ "APPROVED", "", "YES", expiry ]]
    }
  });
}

--------------------------------------------------
16. IMPORTANT
--------------------------------------------------

DO NOT CHANGE:
---------------
- Cloudinary logic
- Google auth logic
- Webhook verification
- State management
- Interest flow
- Details flow
- Delete flow

ONLY CHANGE:
-------------
- Search
- Approval system
- Payment flow
- Google Sheet structure
- Remove Shiv

==================================================
FINAL RESULT
==================================================

✔ Existing stable bot remains safe
✔ Pending + approved visible
✔ Single profile browsing
✔ Better UX
✔ Membership system added
✔ Shiv removed
✔ Admin approvals upgraded
✔ Bilingual messages retained
