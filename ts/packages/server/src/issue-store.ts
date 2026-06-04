import Database from "better-sqlite3";

export interface IssueRecord {
  id: string;
  identifier: string;
  title: string | null;
  url: string | null;
}

export class IssueStore {
  private db: Database.Database;
  private upsertStmt: Database.Statement;
  private getStmt: Database.Statement;
  private getAllStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        title TEXT,
        url TEXT
      )
    `);
    this.upsertStmt = this.db.prepare(`
      INSERT INTO issues (id, identifier, title, url)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        identifier = excluded.identifier,
        title = excluded.title,
        url = excluded.url
    `);
    this.getStmt = this.db.prepare("SELECT id, identifier, title, url FROM issues WHERE id = ?");
    this.getAllStmt = this.db.prepare("SELECT id, identifier, title, url FROM issues");
  }

  upsert(record: IssueRecord): void {
    this.upsertStmt.run(record.id, record.identifier, record.title, record.url);
  }

  get(id: string): IssueRecord | undefined {
    return this.getStmt.get(id) as IssueRecord | undefined;
  }

  getAll(): IssueRecord[] {
    return this.getAllStmt.all() as IssueRecord[];
  }

  close(): void {
    this.db.close();
  }
}
