export type DriveFileType =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "image"
  | "msword"
  | "excel"
  | "powerpoint"
  | "odt"
  | "odp"
  | "ods"
  | "unknown";

export interface DriveFileMetadata {
  id: string;
  name?: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  owners?: Array<{
    displayName?: string;
    emailAddress?: string;
  }>;
  lastModifyingUser?: {
    displayName?: string;
    emailAddress?: string;
  };
  webViewLink?: string;
  thumbnailLink?: string;
  accessMessage?: string;
}

export type DocumentFile = {
  name: string;
  url: string;
  content: string;
  author: string;
};

export interface DocumentContent {
  pages?: Array<{
    pageNumber: number;
    content?: string;
  }>;
  image?: Array<{
    title?: string;
    content?: string;
  }>;
}

export interface ParsedDriveLink {
  fileId: string;
  fileType: DriveFileType;
  isAccessible: boolean;
  metadata: DriveFileMetadata;
  content?: string | DocumentContent;
  contentType?: string;
  isBase64?: boolean;
  isStructured?: boolean;
  rawSize?: number;
}
