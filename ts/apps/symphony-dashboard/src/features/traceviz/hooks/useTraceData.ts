import { useState, useEffect, useCallback, useRef } from "react";
// The stats subpath avoids pulling the server's Node-only watcher into the browser bundle.
import { computeStats } from "@symphony/traceviz-server/stats";

import { useWebSocket } from "../../../shared/hooks/useWebSocket";
import type { TicketInfo, DisplayEvent, Stats } from "../api/types";
import { fetchTickets, fetchEvents, fetchStats } from "../api/client";

const FOLLOW_THRESHOLD_PX = 50;

export function useFollowMode() {
  const [following, setFollowing] = useState(true);
  const [hasNewUpdates, setHasNewUpdates] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const atTop = window.scrollY < FOLLOW_THRESHOLD_PX;
      setFollowing(atTop);
      if (atTop) setHasNewUpdates(false);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const markNewUpdates = useCallback(() => setHasNewUpdates(true), []);
  const scrollToTop = useCallback(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return { following, hasNewUpdates, markNewUpdates, scrollToTop };
}

export function useTraceData() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceExists, setTraceExists] = useState<boolean | null>(null);

  const { status: wsStatus, lastMessage } = useWebSocket();
  const { following, hasNewUpdates, markNewUpdates, scrollToTop } = useFollowMode();
  const followingRef = useRef(following);
  followingRef.current = following;
  const needsCatchUpRef = useRef(false);

  const loadTickets = useCallback(async () => {
    const data = await fetchTickets();
    setTickets(data);
  }, []);

  const loadTicketData = useCallback(async (issueId: string) => {
    setLoading(true);
    setTraceExists(null);
    try {
      setError(null);
      const [eventsData, statsData] = await Promise.all([
        fetchEvents(issueId),
        fetchStats(issueId),
      ]);
      setEvents(eventsData);
      setStats(statsData);
      setTraceExists(eventsData.length > 0);
    } catch {
      setError("Failed to load trace data");
      setEvents([]);
      setStats(null);
      setTraceExists(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshTicketData = useCallback(async (issueId: string) => {
    try {
      const [eventsData, statsData] = await Promise.all([
        fetchEvents(issueId),
        fetchStats(issueId),
      ]);
      setEvents(eventsData);
      setStats(statsData);
      setTraceExists(eventsData.length > 0);
    } catch {
      // Stale data is better than flickering
    }
  }, []);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    if (selectedTicketId) {
      void loadTicketData(selectedTicketId);
    } else {
      setEvents([]);
      setStats(null);
      setTraceExists(null);
    }
  }, [selectedTicketId, loadTicketData]);

  // Catch up when user scrolls back to top
  useEffect(() => {
    if (following && needsCatchUpRef.current && selectedTicketId) {
      needsCatchUpRef.current = false;
      void refreshTicketData(selectedTicketId);
    }
  }, [following, selectedTicketId, refreshTicketData]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage;

    if (msg.type === "init") {
      setTickets(msg.tickets);
    } else if (msg.type === "update") {
      setTickets(msg.tickets);
      if (msg.issueId === selectedTicketId) {
        if (followingRef.current) {
          void refreshTicketData(msg.issueId);
        } else {
          needsCatchUpRef.current = true;
          markNewUpdates();
        }
      }
    } else if (msg.type === "events" && msg.issueId === selectedTicketId) {
      if (followingRef.current) {
        setEvents(msg.events);
        setStats(computeStats(msg.events));
        setTraceExists(true);
      } else {
        needsCatchUpRef.current = true;
        markNewUpdates();
      }
    }
  }, [lastMessage, refreshTicketData, selectedTicketId, markNewUpdates]);

  return {
    tickets,
    selectedTicketId,
    setSelectedTicketId,
    events,
    stats,
    loading,
    error,
    traceExists,
    wsStatus,
    following,
    hasNewUpdates,
    scrollToTop,
  };
}
