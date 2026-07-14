/**
 * mongodb.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MongoDB Grammy session storage adapter with local JSON file fallback.
 * Stores one document per user in the `liquidator_sessions` collection,
 * and maintains a local JSON fallback inside `./data/fallback_sessions/`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { MongoClient, type Db, type Collection } from 'mongodb';
import type { StorageAdapter } from 'grammy';
import type { SessionData } from '../types/index.js';
import * as fs from 'fs';
import * as path from 'path';

interface MongoSession {
  _id: string;
  userId: string;
  data: SessionData;
  createdAt: Date;
  updatedAt: Date;
}

export class MongoDBStorage implements StorageAdapter<SessionData> {
  private client: MongoClient;
  private _db!: Db;
  private collection!: Collection<MongoSession>;
  private connected = false;
  private fallbackDir = path.resolve(process.cwd(), 'data/fallback_sessions');

  get db(): Db { return this._db; }
  get isConnected(): boolean { return this.connected; }

  constructor(
    private connectionString: string,
    private databaseName: string = 'kyber_liquidator',
    private collectionName: string = 'liquidator_sessions',
  ) {
    this.client = new MongoClient(connectionString);
    try {
      fs.mkdirSync(this.fallbackDir, { recursive: true });
    } catch (err) {
      console.error('[Storage] Failed to create fallback directory:', err);
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.connect();
      this._db = this.client.db(this.databaseName);
      this.collection = this._db.collection<MongoSession>(this.collectionName);
      await this.collection.createIndex({ userId: 1 }, { unique: true });
      await this.collection.createIndex({ updatedAt: 1 });
      this.connected = true;
      console.log('✅ MongoDB connected');
    } catch (err) {
      console.error('❌ MongoDB connection failed:', err);
      // We do not throw here, allowing the bot to start using fallback storage
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      try {
        await this.client.close();
      } catch (err) {
        console.error('[Storage] Error during MongoDB close:', err);
      }
      this.connected = false;
      console.log('📴 MongoDB disconnected');
    }
  }

  private getFallbackPath(key: string): string {
    return path.join(this.fallbackDir, `${key}.json`);
  }

  async read(key: string): Promise<SessionData | undefined> {
    // 1. Try local fallback first (it represents the latest state if DB writes are blocked)
    const localPath = this.getFallbackPath(key);
    if (fs.existsSync(localPath)) {
      try {
        const content = fs.readFileSync(localPath, 'utf8');
        return JSON.parse(content);
      } catch (err) {
        console.error(`[Storage] Failed to read fallback session for ${key}:`, err);
      }
    }

    // 2. Fallback to MongoDB
    try {
      if (!this.connected) await this.connect();
      if (this.connected) {
        const doc = await this.collection.findOne({ userId: key });
        if (doc?.data) {
          // Sync locally for future read/write speed and fallback
          try {
            fs.writeFileSync(localPath, JSON.stringify(doc.data, null, 2));
          } catch (e) {
            console.error('[Storage] Failed to sync MongoDB read to fallback file:', e);
          }
          return doc.data;
        }
      }
    } catch (err) {
      console.error(`[Storage] MongoDB read failed for ${key}:`, err);
    }
    return undefined;
  }

  async write(key: string, value: SessionData): Promise<void> {
    // 1. Always write to local fallback first
    const localPath = this.getFallbackPath(key);
    try {
      fs.writeFileSync(localPath, JSON.stringify(value, null, 2));
    } catch (err) {
      console.error(`[Storage] Failed to write fallback session for ${key}:`, err);
    }

    // 2. Try to write to MongoDB
    try {
      if (!this.connected) await this.connect();
      if (this.connected) {
        const now = new Date();
        await this.collection.updateOne(
          { userId: key },
          {
            $set: { data: value, updatedAt: now },
            $setOnInsert: { _id: `session_${key}`, userId: key, createdAt: now },
          },
          { upsert: true },
        );
      }
    } catch (err: any) {
      console.warn(`[Storage] ⚠️ MongoDB write failed/blocked (using local fallback instead): ${err.message || err}`);
    }
  }

  async delete(key: string): Promise<void> {
    // 1. Delete local fallback
    const localPath = this.getFallbackPath(key);
    if (fs.existsSync(localPath)) {
      try {
        fs.unlinkSync(localPath);
      } catch (err) {
        console.error(`[Storage] Failed to delete fallback session for ${key}:`, err);
      }
    }

    // 2. Delete from MongoDB
    try {
      if (!this.connected) await this.connect();
      if (this.connected) {
        await this.collection.deleteOne({ userId: key });
      }
    } catch (err) {
      console.error(`[Storage] MongoDB delete failed for ${key}:`, err);
    }
  }

  async getAllSessions(): Promise<Array<{ userId: string; data: SessionData }>> {
    const sessionsMap = new Map<string, SessionData>();

    // 1. Read from MongoDB first
    try {
      if (!this.connected) await this.connect();
      if (this.connected) {
        const docs = await this.collection.find({}).toArray();
        for (const doc of docs) {
          if (doc?.userId && doc?.data) {
            sessionsMap.set(doc.userId, doc.data);
          }
        }
      }
    } catch (err) {
      console.error('[Storage] MongoDB getAllSessions failed:', err);
    }

    // 2. Read from local fallback to override / supplement
    try {
      if (fs.existsSync(this.fallbackDir)) {
        const files = fs.readdirSync(this.fallbackDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const userId = path.basename(file, '.json');
            const localPath = path.join(this.fallbackDir, file);
            try {
              const content = fs.readFileSync(localPath, 'utf8');
              sessionsMap.set(userId, JSON.parse(content));
            } catch (err) {
              console.error(`[Storage] Failed to read fallback session file ${file}:`, err);
            }
          }
        }
      }
    } catch (err) {
      console.error('[Storage] Local fallback getAllSessions failed:', err);
    }

    return Array.from(sessionsMap.entries()).map(([userId, data]) => ({ userId, data }));
  }

  async isWalletAddressTaken(
    address: string,
    excludeUserId?: string,
  ): Promise<{ taken: boolean; byUserId?: string }> {
    const normalised = address.toLowerCase();

    try {
      const all = await this.getAllSessions();
      for (const item of all) {
        if (excludeUserId && item.userId === excludeUserId) continue;
        const wallets = item.data.wallets ?? [];
        const match = wallets.find(w => w.address.toLowerCase() === normalised);
        if (match) {
          return { taken: true, byUserId: item.userId };
        }
      }
    } catch (err) {
      console.error('[Storage] isWalletAddressTaken check failed:', err);
    }

    return { taken: false };
  }
}

// Singleton instance
export const mongoStorage = new MongoDBStorage(
  process.env.MONGODB_URI || 'mongodb://localhost:27017',
);
