export class SessionRegistry<T extends { lastSeenAt: number }> {
  private readonly sessionsByUserId = new Map<string, Set<T>>();

  get userCount(): number {
    return this.sessionsByUserId.size;
  }

  clear(): void {
    this.sessionsByUserId.clear();
  }

  hasUser(userId: string): boolean {
    return this.sessionsByUserId.has(userId);
  }

  add(userId: string, session: T): void {
    const sessions = this.sessionsByUserId.get(userId) || new Set<T>();
    sessions.add(session);
    this.sessionsByUserId.set(userId, sessions);
  }

  remove(userId: string, session: T): boolean {
    const sessions = this.sessionsByUserId.get(userId);
    if (!sessions) return false;
    sessions.delete(session);
    if (sessions.size > 0) return false;
    this.sessionsByUserId.delete(userId);
    return true;
  }

  forUser(userId: string): T[] {
    return Array.from(this.sessionsByUserId.get(userId) || []);
  }

  entries(): Array<[string, T]> {
    return Array.from(this.sessionsByUserId.entries())
      .flatMap(([userId, sessions]) => Array.from(sessions).map((session): [string, T] => [userId, session]));
  }

  primarySessions(): T[] {
    return Array.from(this.sessionsByUserId.values())
      .map((sessions) => Array.from(sessions).sort((left, right) => right.lastSeenAt - left.lastSeenAt)[0])
      .filter((session): session is T => Boolean(session));
  }
}
