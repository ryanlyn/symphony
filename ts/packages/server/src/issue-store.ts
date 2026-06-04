import Database from "better-sqlite3";

export interface IssueRecord {
  issueId: string;
  /** Human-readable ticket key (e.g. "ENG-123") — distinct from issueId which is the tracker's opaque UUID. */
  issueIdentifier: string;
  title: string | null;
  url: string | null;
}

export class IssueStore {
  private readonly db: Database.Database;
  private readonly upsertStmt: Database.Statement;
  private readonly getStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY,
        issueId TEXT NOT NULL UNIQUE,
        issueIdentifier TEXT NOT NULL,
        title TEXT,
        url TEXT
      )
    `);
    this.upsertStmt = this.db.prepare(`
      INSERT INTO issues (issueId, issueIdentifier, title, url) VALUES (?, ?, ?, ?)
      ON CONFLICT(issueId) DO UPDATE SET
        issueIdentifier = excluded.issueIdentifier,
        title = excluded.title,
        url = excluded.url
    `);
    this.getStmt = this.db.prepare(
      "SELECT issueId, issueIdentifier, title, url FROM issues WHERE issueId = ?",
    );
  }

  upsert(record: IssueRecord): void {
    this.upsertStmt.run(record.issueId, record.issueIdentifier, record.title, record.url);
  }

  get(issueId: string): IssueRecord | undefined {
    return this.getStmt.get(issueId) as IssueRecord | undefined;
  }

  close(): void {
    this.db.close();
  }
}
