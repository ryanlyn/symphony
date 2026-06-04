import Database from "better-sqlite3";

export interface IssueRecord {
  issueId: string;
  issueIdentifier: string;
  title: string | null;
  url: string | null;
}

export class IssueStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private updateStmt: Database.Statement;
  private getStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issueId TEXT NOT NULL,
        issueIdentifier TEXT NOT NULL,
        title TEXT,
        url TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_issues_issueId ON issues(issueId)
    `);
    this.insertStmt = this.db.prepare(
      "INSERT INTO issues (issueId, issueIdentifier, title, url) VALUES (?, ?, ?, ?)",
    );
    this.updateStmt = this.db.prepare(
      "UPDATE issues SET issueIdentifier = ?, title = ?, url = ? WHERE issueId = ?",
    );
    this.getStmt = this.db.prepare(
      "SELECT issueId, issueIdentifier, title, url FROM issues WHERE issueId = ?",
    );
  }

  upsert(record: IssueRecord): void {
    const existing = this.getStmt.get(record.issueId);
    if (existing) {
      this.updateStmt.run(record.issueIdentifier, record.title, record.url, record.issueId);
    } else {
      this.insertStmt.run(record.issueId, record.issueIdentifier, record.title, record.url);
    }
  }

  get(issueId: string): IssueRecord | undefined {
    return this.getStmt.get(issueId) as IssueRecord | undefined;
  }

  close(): void {
    this.db.close();
  }
}
