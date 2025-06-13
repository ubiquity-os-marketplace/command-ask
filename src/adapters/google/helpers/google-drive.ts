import { drive_v3 } from "googleapis";
import { Context } from "../../../types";
import { parseOfficeAsync } from "officeparser";
import { DocumentContent, DriveFileMetadata, DriveFileType, ParsedDriveLink } from "../../../types/google";
import { SuperGoogle } from "./google";

const GOOGLE_APPS = "google-apps";
const VND_PREFIX = "application/vnd.";
const GOOGLE_APPS_PREFIX = `${VND_PREFIX}${GOOGLE_APPS}.`;
const OPENXML_PREFIX = `${VND_PREFIX}openxmlformats-officedocument`;
const MS_OFFICE_PREFIX = `${VND_PREFIX}ms-`;
const OFFICE_MIME_TYPES: Record<"DOCUMENT" | "SPREADSHEET" | "PRESENTATION", readonly string[]> = {
  SPREADSHEET: [`${GOOGLE_APPS_PREFIX}spreadsheet`, `${OPENXML_PREFIX}.spreadsheetml.sheet`, `${MS_OFFICE_PREFIX}excel`],
  DOCUMENT: [`${GOOGLE_APPS_PREFIX}document`, `${OPENXML_PREFIX}.wordprocessingml.document`, `${MS_OFFICE_PREFIX}word`],
  PRESENTATION: [`${GOOGLE_APPS_PREFIX}presentation`, `${OPENXML_PREFIX}.presentationml.presentation`, `${MS_OFFICE_PREFIX}powerpoint`],
};

const EXPORT_MIME_TYPES = {
  SPREADSHEET: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  DOCUMENT: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PRESENTATION: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  PDF: "application/pdf",
  IMAGE: "image/*",
} as const;

export class GoogleDriveClient extends SuperGoogle {
  constructor(client: drive_v3.Drive, context: Context) {
    super(client, context);
  }

  /**
   * Extract file ID from various Google Drive URL formats
   */
  private _extractFileId(url: string): string | null {
    const patterns = [
      /\/d\/([-\w]{25,})/, // /d/ format, File, Sheets, Docs, Slides
      /id=([-\w]{25,})/, // id= format
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Get file metadata from Google Drive
   */
  private async _getFileMetadata(fileId: string): Promise<drive_v3.Schema$File | null> {
    const response = await this.client.files
      .get({
        fileId,
        fields: "id,name,mimeType,createdTime,modifiedTime,owners,lastModifyingUser,webViewLink,thumbnailLink,size",
      })
      .catch((error) => {
        if (error.code === 403 || error.code === 404) {
          return null;
        }
        throw error;
      });
    return response ? response.data : null;
  }

  /**
   * Determine file type from MIME type and name
   */
  private _determineFileType(mimeType: string, name: string): DriveFileType {
    const isGoogleApps = mimeType.includes(GOOGLE_APPS);

    if (OFFICE_MIME_TYPES.SPREADSHEET.some((type) => mimeType.includes(type))) {
      return isGoogleApps ? "spreadsheet" : "excel";
    }
    if (OFFICE_MIME_TYPES.DOCUMENT.some((type) => mimeType.includes(type))) {
      return isGoogleApps ? "document" : "msword";
    }
    if (OFFICE_MIME_TYPES.PRESENTATION.some((type) => mimeType.includes(type))) {
      return isGoogleApps ? "presentation" : "powerpoint";
    }
    if (mimeType.includes("pdf")) {
      return "pdf";
    }
    if (mimeType.includes("image/") || /\.(jpe?g|png|gif|bmp|webp)$/i.test(name)) {
      return "image";
    }
    return "unknown";
  }

  /**
   * Get export MIME type for file type
   */
  private _getExportMimeType(fileType: DriveFileType): string {
    switch (fileType) {
      case "spreadsheet":
      case "excel":
        return EXPORT_MIME_TYPES.SPREADSHEET;
      case "document":
      case "msword":
      case "odt":
        return EXPORT_MIME_TYPES.DOCUMENT;
      case "presentation":
      case "powerpoint":
      case "odp":
        return EXPORT_MIME_TYPES.PRESENTATION;
      case "image":
        return EXPORT_MIME_TYPES.IMAGE;
      case "pdf":
      case "ods":
      case "unknown":
      default:
        return EXPORT_MIME_TYPES.PDF;
    }
  }

  /**
   * Handle file content by getting OpenXML format where possible
   */
  private async _handleFileContent(fileId: string, fileType: DriveFileType, mimeType: string, name: string): Promise<{ documentContent: DocumentContent }> {
    const response = mimeType.includes(GOOGLE_APPS)
      ? await this.client.files.export(
          {
            fileId,
            mimeType: this._getExportMimeType(fileType),
          },
          { responseType: "arraybuffer" }
        )
      : await this.client.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });

    if (!response?.data) throw new Error("Invalid file content");

    const buffer = Buffer.from(response.data as ArrayBuffer);
    const content = buffer.toString("base64");

    // Handle image files specially
    if (fileType === "image") {
      return {
        documentContent: {
          image: [
            {
              content,
              title: name,
            },
          ],
        },
      };
    }

    try {
      const parsedContent = (await parseOfficeAsync(buffer)) as string;
      return {
        documentContent: {
          pages: [{ pageNumber: 1, content: parsedContent }],
        },
      };
    } catch (error) {
      this.context.logger.error(`Error parsing ${fileType} file: ${error}`);
      return {
        documentContent: {
          pages: [
            {
              pageNumber: 1,
              content: `Unable to extract readable content from ${fileType.toUpperCase()} file. Size: ${buffer.length} bytes.`,
            },
          ],
        },
      };
    }
  }

  /**
   * Create metadata object from response data
   */
  private _createFileMetadata(responseData: drive_v3.Schema$File, id: string, mimeType: string): DriveFileMetadata {
    if (!responseData) {
      throw new Error("Invalid response data");
    }

    return {
      id,
      name: responseData.name?.toString(),
      mimeType,
      createdTime: responseData.createdTime?.toString(),
      modifiedTime: responseData.modifiedTime?.toString(),
      owners: responseData.owners?.map((owner) => ({
        displayName: owner.displayName || undefined,
        emailAddress: owner.emailAddress || undefined,
      })),
      lastModifyingUser: responseData.lastModifyingUser
        ? {
            displayName: responseData.lastModifyingUser.displayName || undefined,
            emailAddress: responseData.lastModifyingUser.emailAddress || undefined,
          }
        : undefined,
      webViewLink: responseData.webViewLink?.toString(),
      thumbnailLink: responseData.thumbnailLink?.toString(),
    };
  }

  /**
   * Parse a Google Drive link and extract file information
   */
  private _handlePermissionError(fileId: string): ParsedDriveLink {
    const serviceAccountEmail = JSON.parse(this.context.env.GOOGLE_SERVICE_ACCOUNT_KEY).client_email;
    const accessMessage = serviceAccountEmail
      ? `Please share the file with ${serviceAccountEmail} to grant access.`
      : "Please ensure the file is shared with the service account (contact administrator for the email address).";

    return {
      fileId,
      fileType: "unknown",
      isAccessible: false,
      metadata: {
        id: fileId,
        accessMessage,
      },
    };
  }

  private _createSuccessResponse(
    fileId: string,
    fileType: DriveFileType,
    metadata: DriveFileMetadata,
    mimeType: string,
    result?: { documentContent?: DocumentContent; content?: string }
  ): ParsedDriveLink {
    return {
      fileId,
      fileType,
      isAccessible: true,
      metadata,
      content: result?.documentContent || result?.content,
      contentType: mimeType,
      isStructured: result?.documentContent !== undefined,
      isBase64: result?.documentContent === undefined && result?.content !== undefined,
      rawSize: result?.content ? Math.round(Buffer.from(result.content, "base64").length / 1024) : undefined,
    };
  }

  async parseDriveLink(url: string): Promise<ParsedDriveLink> {
    const fileId = this._extractFileId(url);
    if (!fileId) {
      throw new Error("Invalid Google Drive URL");
    }

    try {
      const metadataResponse = await this._getFileMetadata(fileId);
      if (!metadataResponse?.mimeType || !metadataResponse?.name || !metadataResponse?.id) {
        return {
          fileId,
          fileType: "unknown",
          isAccessible: false,
          metadata: { id: fileId },
        };
      }

      const { mimeType, name, id } = metadataResponse;
      const fileType = this._determineFileType(mimeType, name);
      const metadata = this._createFileMetadata(metadataResponse, id, name);
      const result = await this._handleFileContent(fileId, fileType, mimeType, name);
      return this._createSuccessResponse(fileId, fileType, metadata, mimeType, result);
    } catch (error) {
      if (error instanceof Error && error.message.includes("403")) {
        return this._handlePermissionError(fileId);
      }
      throw error;
    }
  }
}
