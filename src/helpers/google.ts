type GoogleStorageType = "SLIDES" | "DOCS" | "SHEETS";
import { google } from "googleapis";
const SERVICE_ACCOUNT_FILE = "./service-account.json";

async function authenticate() {
  return new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: [
      "https://www.googleapis.com/auth/documents.readonly",
      "https://www.googleapis.com/auth/presentations.readonly",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
}

export const consumeUrl = (url: string, type?: GoogleStorageType) => {
  const regex = /https:\/\/docs\.google\.com\/(spreadsheets|document|presentation)\/d\/([a-zA-Z0-9_-]+)(?:\/edit)?(?:\?gid=(\d+)|#slide=id\.([a-zA-Z0-9_-]+))?/;
  const match = url.match(regex);
  if (!match) {
    throw new Error("Invalid Google Docs URL!");
  }

  let extractedType = match[1].toUpperCase();
  if (match[1] === "spreadsheets") extractedType = "SHEETS";
  if (match[1] === "document") extractedType = "DOCS";
  if (match[1] === "presentation") extractedType = "SLIDES";
  const docId = match[2];
  const sheetId = match[3];
  const slideId = match[4];

  if (type && extractedType !== type) {
    throw new Error(`Storage type mismatch! ${type} expected but found ${extractedType}`);
  }
  if (!["SLIDES", "DOCS", "SHEETS"].includes(extractedType)) {
    throw new Error("Unsupported storage type!");
  }

  return {
    docType: extractedType,
    documentId: docId,
    sheetId: sheetId || null,
    slideId: slideId || null,
  };
};

const getContentFromSpreadsheet = async (documentId: string) => {
  const auth = await authenticate();
  const sheets = google.sheets({ version: "v4", auth });

  try {
    // Get spreadsheet metadata (to get all sheet names)
    const spreadsheetInfo = await sheets.spreadsheets.get({ spreadsheetId: documentId });
    if (!spreadsheetInfo.data.sheets) {
      console.log("No sheets to fetch!");
      return;
    }
    const sheetNames = spreadsheetInfo.data.sheets.map((sheet) => sheet.properties?.title).filter((el) => !!el);

    console.log(`Spreadsheet Title: ${spreadsheetInfo.data.properties?.title}`);
    console.log(`Sheets Found: ${sheetNames.join(", ")}`);

    const text = [] as string[];

    // Fetch data from each sheet
    for (const sheetName of sheetNames) {
      console.log(`\nFetching data from sheet: ${sheetName}`);

      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: documentId,
        range: `${sheetName}`,
      });

      const rows = result.data.values;
      if (!rows || rows.length === 0) {
        console.log(`No data found in sheet: ${sheetName}`);
        continue;
      }

      console.log(rows.flat().reduce((v1, v2) => (v1 += String(v2) + "\n")));

      // text += rows.flat().reduce((v1, v2) => v1 += String(v2) + "\n");
    }

    return text;
  } catch (error) {
    console.error(error);
  }
};

const getContentFromDocs = async (documentId: string) => {
  const auth = await authenticate();
  const docs = google.docs({ version: "v1", auth });

  try {
    const res = await docs.documents.get({ documentId: documentId });
    const doc = res.data;
    if (!doc.body || !doc.body.content) {
      throw new Error("Error fetching from docs");
    }

    let text = "";
    // Extract text from the document body
    doc.body.content.forEach((element) => {
      if (element.paragraph && element.paragraph.elements) {
        element.paragraph.elements.forEach((paraElement) => {
          if (paraElement.textRun) {
            text += paraElement.textRun.content;
          }
        });
      }
    });

    return text;
  } catch (error) {
    console.error(error);
  }
};

const getContentFromSlides = async (documentId: string) => {
  const auth = await authenticate();

  const slides = google.slides({ version: "v1", auth });

  try {
    const res = await slides.presentations.get({ presentationId: documentId });
    const presentation = res.data;

    console.log(`Title: ${presentation.title}`);

    if (!presentation.slides) {
      console.log("Nothign to fetch");
      return;
    }

    let textContent = "";

    presentation.slides.forEach((slide, index) => {
      console.log(`Slide ${index + 1}:`);
      if (!slide.pageElements) return;
      slide.pageElements.forEach((element) => {
        if (element.shape && element.shape.text && element.shape.text.textElements) {
          element.shape.text.textElements.forEach((textElement) => {
            if (textElement.textRun && textElement.textRun.content) {
              textContent += textElement.textRun.content;
            }
          });
        }
      });
    });

    console.log("\nExtracted Text:\n", textContent);
    return textContent;
  } catch (error) {
    console.error(error);
  }
};

export const getContentFromUrl = async (url: string) => {
  const { docType, documentId } = consumeUrl(url);
  switch (docType) {
    case "SHEETS":
      return await getContentFromSpreadsheet(documentId);
    case "DOCS":
      return await getContentFromDocs(documentId);
    case "SLIDES":
      return await getContentFromSlides(documentId);

    default:
      throw new Error("Unsupported storage type!");
  }
};
