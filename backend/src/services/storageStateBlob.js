import { BlobServiceClient } from "@azure/storage-blob";

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER || "playwright-sessions";

let containerClient = null;

export async function getContainerClient() {
  if (containerClient) return containerClient;
  if (!CONN) throw new Error("AZURE_STORAGE_CONNECTION_STRING missing");

  const svc = BlobServiceClient.fromConnectionString(CONN);
  containerClient = svc.getContainerClient(CONTAINER);
  await containerClient.createIfNotExists();
  return containerClient;
}

export async function loadStorageState(sessionId) {
  const cc = await getContainerClient();
  const blob = cc.getBlockBlobClient(`${sessionId}/storageState.json`);
  try {
    const buf = await blob.downloadToBuffer();
    return JSON.parse(buf.toString("utf-8"));
  } catch {
    return null;
  }
}

export async function saveStorageState(sessionId, context) {
  const cc = await getContainerClient();
  const blob = cc.getBlockBlobClient(`${sessionId}/storageState.json`);

  const state = await context.storageState();
  const json = JSON.stringify(state);

  await blob.upload(json, Buffer.byteLength(json), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });
}