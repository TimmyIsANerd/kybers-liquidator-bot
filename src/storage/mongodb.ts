/**
 * mongodb.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * MongoDB Grammy session storage adapter.
 * Stores one document per user in the `liquidator_sessions` collection.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { MongoClient, type Db, type Collection } from 'mongodb';
import type { StorageAdapter } from 'grammy';
import type { SessionData } from '../types/index.js';

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

  get db(): Db { return this._db; }
  get isConnected(): boolean { return this.connected; }

  constructor(
    private connectionString: string,
    private databaseName: string = 'kyber_liquidator',
    private collectionName: string = 'liquidator_sessions',
  ) {
    this.client = new MongoClient(connectionString);
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
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
      console.log('📴 MongoDB disconnected');
    }
  }

  async read(key: string): Promise<SessionData | undefined> {
    if (!this.connected) await this.connect();
    const doc = await this.collection.findOne({ userId: key });
    return doc?.data;
  }

  async write(key: string, value: SessionData): Promise<void> {
    if (!this.connected) await this.connect();
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

  async delete(key: string): Promise<void> {
    if (!this.connected) await this.connect();
    await this.collection.deleteOne({ userId: key });
  }

  /**
   * Get all sessions (for rehydrating liquidation engine on startup).
   * Returns all documents as [userId, data] pairs.
   */
  async getAllSessions(): Promise<Array<{ userId: string; data: SessionData }>> {
    if (!this.connected) await this.connect();
    const docs = await this.collection.find({}).toArray();
    return docs.map(d => ({ userId: d.userId, data: d.data }));
  }
}

// Singleton instance
export const mongoStorage = new MongoDBStorage(
  process.env.MONGODB_URI || 'mongodb://localhost:27017',
);
