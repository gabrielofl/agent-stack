// src/db/cosmos.client.js
import { CosmosClient } from "@azure/cosmos";
import {
  COSMOS_ENABLED,
  COSMOS_ENDPOINT,
  COSMOS_KEY,
  COSMOS_DATABASE_ID
} from "../config/env.js";

let client = null;
let database = null;

export function isCosmosEnabled() {
  return COSMOS_ENABLED;
}

export async function connectCosmos() {
  if (!COSMOS_ENABLED) {
    console.log("[cosmos] disabled (COSMOS_ENABLED=0)");
    return null;
  }

  if (database) return database;

  client = new CosmosClient({
    endpoint: COSMOS_ENDPOINT,
    key: COSMOS_KEY
  });

  // Ensure DB exists (or just .database() if you don't want auto-create)
  const { database: db } = await client.databases.createIfNotExists({
    id: COSMOS_DATABASE_ID
  });

  database = db;
  console.log(`[cosmos] connected to database: ${COSMOS_DATABASE_ID}`);
  return database;
}

export function getCosmosDb() {
  if (!database) {
    throw new Error("Cosmos DB not connected yet. Call connectCosmos() first.");
  }
  return database;
}