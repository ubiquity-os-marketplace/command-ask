import { fileTypeFromBuffer } from "file-type";
import { lookup as mimeLookup } from "mime-types";
import ms from "ms";
import { parseOfficeAsync } from "officeparser";
import { GoogleDriveClient } from "../adapters/google/helpers/google-drive";
import { Context } from "../types";
import { DocumentFile, ParsedDriveLink } from "../types/google";

const POLL_INTERVAL = 25000; // 25 seconds
const MAX_POLL_TIME = 900000; // 15 minutes

interface DriveLink {
  url: string;
  data?: ParsedDriveLink;
  requiresPermission: boolean;
}

export async function extractAttachments(context: Context, question: string) {
  context.logger.info("Checking for uploaded attachments in the question");
  // eslint-disable-next-line sonarjs/slow-regex
  const attachmentUrlPattern = /\[([^\]]+)\]\((https:\/\/github\.com\/user-attachments\/files\/[^\s)]+)\)/g;
  const matches = [...question.matchAll(attachmentUrlPattern)];
  const attachments = matches.map((match) => ({
    name: match[1],
    url: match[2],
    originalFileName: match[2].split("/").pop(),
  }));

  if (attachments.length === 0) {
    context.logger.info("No attachments found in the question");
    return [];
  }

  context.logger.info(`Found ${attachments.length} potential attachments`, { attachments });
  const documents: DocumentFile[] = [];
  for (const attachment of attachments) {
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        context.logger.warn(`Failed to fetch attachment [${attachment.url}]: ${response.statusText}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      const type = await fileTypeFromBuffer(buffer); // binary types
      const mimeByExt = mimeLookup(attachment.originalFileName ?? ""); // other types
      let content: string;
      if (type && ["docx", "pptx", "xlsx", "odt", "odp", "ods", "pdf"].includes(type.ext)) {
        content = await parseOfficeAsync(buffer);
      } else if (mimeByExt && (mimeByExt.startsWith("text/") || ["application/json", "application/xml", "application/csv"].includes(mimeByExt))) {
        content = buffer.toString("utf-8");
      } else {
        context.logger.info(`Unsupported file type for attachment [${attachment.url}]: ${type?.ext || mimeByExt}`);
        content = "[Unsupported file type]";
      }
      documents.push({
        name: attachment.originalFileName || attachment.name,
        author: "",
        content: content,
        url: attachment.url,
      });
    } catch (err) {
      context.logger.warn(`Error processing attachment [${attachment.url}]`, { err });
    }
  }

  context.logger.info(`Extracted ${documents.length} documents from attachments`, { documents });
  return documents;
}

/**
 * Check for Drive links and their accessibility
 */
export async function checkDriveLinks(context: Context, question: string): Promise<DriveLink[]> {
  const { google } = context.adapters;
  if (!google) {
    context.logger.info("Skipping Drive link processing");
    return [];
  }

  const driveUrlPattern = /https:\/\/(docs|drive|sheets|slides)\.google\.com\/[^\s"<>)}\]]+(?=[\s"<>)}\]]|$)/g;
  const matches = [...question.matchAll(driveUrlPattern)];

  if (matches.length === 0) {
    context.logger.info("No Drive links found in regex search");
    return [];
  }

  context.logger.info(`Found ${matches.length} potential Drive links: ${matches.map((m) => m[0]).join(", ")}`);

  const processedUrls = new Set<string>();
  const driveLinks: DriveLink[] = [];

  for (const match of matches) {
    const url = match[0];
    if (processedUrls.has(url)) {
      continue;
    }
    processedUrls.add(url);

    try {
      const parsedLink = await google.drive.parseDriveLink(url);
      if (!parsedLink.isAccessible) {
        driveLinks.push({
          url,
          data: parsedLink,
          requiresPermission: true,
        });
      } else {
        driveLinks.push({
          url,
          requiresPermission: false,
        });
      }
    } catch (error) {
      context.logger.error(`Error processing Drive link ${url}: ${error}`);
    }
  }

  context.logger.info(`Processed ${driveLinks.length} valid Drive links`);
  return driveLinks;
}

/**
 * Check for access to Drive files
 */
export async function checkAccessStatus(drive: GoogleDriveClient, links: DriveLink[]): Promise<{ updated: DriveLink[] | undefined; hasPermission: boolean }> {
  const linksNeedingPermission = links.filter((link) => link.requiresPermission);

  if (linksNeedingPermission.length === 0) {
    return { updated: undefined, hasPermission: true };
  }

  let hasFullAccess = true;
  const updated: DriveLink[] = [];
  for (const link of linksNeedingPermission) {
    try {
      const driveLinkInfo = await drive.parseDriveLink(link.url);
      if (!driveLinkInfo.isAccessible || !driveLinkInfo.content) {
        hasFullAccess = false;
        break;
      }
      // Store the parsed result data and update permission status
      updated.push({
        ...link,
        requiresPermission: false,
        data: driveLinkInfo,
      });
    } catch {
      hasFullAccess = false;
      break;
    }
  }

  return { updated: updated.length > 0 ? updated : undefined, hasPermission: hasFullAccess };
}

/**
 * Format access request message
 */
export function formatAccessRequestMessage(context: Context, links: DriveLink[]): string | undefined {
  const linksNeedingPermission = links.filter((link) => link.requiresPermission);

  if (linksNeedingPermission.length === 0) {
    return;
  }

  const fileList = linksNeedingPermission.map((link) => `- ${link.url}`).join("\n");
  const serviceAccountEmail = JSON.parse(context.env.GOOGLE_SERVICE_ACCOUNT_KEY).client_email;

  return `I need access to continue. Please share these files with ${serviceAccountEmail}:\n\n${fileList}\n\nI'll wait up to ${ms(MAX_POLL_TIME, { long: true })} for access to be granted.`;
}

/**
 * Get content from Drive files once access is granted
 */
export async function getDriveContents(context: Context, links: DriveLink[]): Promise<{ driveContents: DocumentFile[] }> {
  const { google } = context.adapters;
  if (!google) {
    context.logger.info("Google adapter not found.");
    return { driveContents: [] };
  }

  const driveContents: DocumentFile[] = [];
  context.logger.info(`Fetching content for ${links.length} Drive files`);

  for (const link of links) {
    context.logger.info(`Fetching content for ${link.url}`);
    try {
      const driveContent = link.data || (await google.drive.parseDriveLink(link.url));
      context.logger.info(`Parsed Drive link: ${JSON.stringify(driveContent)}`);
      if (!driveContent.isAccessible || !driveContent.content) {
        continue;
      }
      context.logger.info(`Fetched content for "${driveContent.metadata.name}" with type ${driveContent.fileType}`);
      let content;
      if (driveContent.isStructured && typeof driveContent.content === "object" && driveContent.content.pages) {
        content = driveContent.content.pages
          .map((page) => {
            return `Page ${page.pageNumber}:\n${page.content || ""}`;
          })
          .join("\n\n");
      } else if (driveContent.isBase64) {
        if (driveContent.fileType === "image") {
          content = driveContent.content as string;
        } else {
          const contentStr = driveContent.content as string;
          const FILE_SIZE_KB = Math.round((contentStr.length * 3) / 4 / 1024);
          content = `File "${driveContent.metadata.name}" (${driveContent.fileType}, ${FILE_SIZE_KB}KB)`;
        }
      } else if (typeof driveContent.content === "string") {
        content = driveContent.content;
      }

      const match = link.url.match(/\/d\/([^/]+)/);
      driveContents.push({
        name: match ? `document-${match[1]}` : link.url,
        content: `Content of "${driveContent.metadata.name}":\n${content}`,
        author: driveContent.metadata.owners?.[0]?.displayName || "Unknown",
        url: link.url,
      });
    } catch (error) {
      context.logger.error(`Failed to fetch content for ${link.url}: ${error}`);
      continue;
    }
  }
  return { driveContents };
}

/**
 * Handle Drive permission flow
 */
export async function handleDrivePermissions(
  context: Context,
  question: string
): Promise<{ hasPermission: boolean; message?: string; driveContents?: DocumentFile[] } | undefined> {
  context.logger.info("Checking for Drive links in the question");

  // Check if Drive link processing is enabled in settings
  if (context.config.processDocumentLinks === false) {
    context.logger.info("Document processing is disabled in settings");
    return;
  }

  const { google } = context.adapters;
  if (!google) {
    context.logger.info("Google adapter not found, skipping Drive link processing");
    return;
  }

  // Check for Drive links
  let driveLinks = await checkDriveLinks(context, question);
  context.logger.info(`Found ${driveLinks.length} Drive links`);

  if (driveLinks.length === 0) {
    context.logger.info("No Drive links found, returning hasPermission: true");
    return { hasPermission: true };
  }

  // If any links need permission, start polling flow
  const accessMessage = formatAccessRequestMessage(context, driveLinks);
  context.logger.info(`Access message: ${accessMessage}`);

  if (accessMessage) {
    context.logger.info("Some links require permission, starting polling flow");
    // Post access request message
    await context.commentHandler.postComment(
      context,
      context.logger.ok(`${accessMessage}\n\nPlease grant access to the Google Drive files. I'll check again in ${POLL_INTERVAL / 1000} seconds.`),
      { updateComment: true }
    );
    const startTime = Date.now();
    let hasAccess = false;

    while (Date.now() - startTime < MAX_POLL_TIME) {
      const status = await checkAccessStatus(google.drive, driveLinks);
      if (status.updated) {
        // Replace old links with updated ones, keep others unchanged
        driveLinks = driveLinks.map((link) => {
          const updatedLink = status.updated?.find((u) => u.url === link.url);
          return updatedLink || link;
        });
      }
      if (status.hasPermission) {
        hasAccess = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    if (!hasAccess) {
      context.logger.warn("Access not granted within time limit");
      await context.commentHandler.postComment(context, context.logger.error("Access not granted within time limit"), { updateComment: true });
      return { hasPermission: false, message: "Access not granted within time limit." };
    }

    context.logger.info("Access granted to all Google Drive files");
    // Post access granted message
    await context.commentHandler.postComment(context, context.logger.ok("Access granted to all Google Drive files. Proceeding with the request."), {
      updateComment: true,
    });
  }

  context.logger.info("Fetching contents of accessible Drive files");
  // All files are now accessible, get their contents
  const { driveContents } = await getDriveContents(context, driveLinks);
  context.logger.info(`Returning hasPermission: true, driveContents count: ${driveContents.length}`);
  return {
    hasPermission: true,
    driveContents: driveContents.length > 0 ? driveContents : undefined,
  };
}
