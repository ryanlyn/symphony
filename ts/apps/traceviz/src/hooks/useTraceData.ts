import { useState, useEffect, useCallback } from "react";
import type { TicketInfo, DisplayEvent, Stats, WsMessage } from "../api/types";
import { fetchTickets, fetchEvents, fetchStats } from "../api/client";
import { useWebSocket } from "./useWebSocket";

export function useTraceData() {
  const [tickets, setTickets] = useState<TicketInfo[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [events, setEvents] = useState<DisplayEvent[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);

  const { status: wsStatus, lastMessage } = useWebSocket();

  const loadTickets = useCallback(async () => {
    const data = await fetchTickets();
    setTickets(data);
  }, []);

  const loadTicketData = useCallback(async (issueId: string) => {
    setLoading(true);
    try {
      const [eventsData, statsData] = await Promise.all([
        fetchEvents(issueId),
        fetchStats(issueId),
      ]);
      setEvents(eventsData);
      setStats(statsData);
    } catch {
      setEvents([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    if (selectedTicketId) {
      loadTicketData(selectedTicketId);
    } else {
      setEvents([]);
      setStats(null);
    }
  }, [selectedTicketId, loadTicketData]);

  useEffect(() => {
    if (!lastMessage) return;
    const msg = lastMessage as WsMessage;

    if (msg.type === "init") {
      setTickets(msg.tickets);
    } else if (msg.type === "events_update" && msg.issueId === selectedTicketId) {
      loadTicketData(msg.issueId);
    } else if (msg.type === "events" && msg.issueId === selectedTicketId) {
      setEvents(msg.events);
    }
  }, [lastMessage, selectedTicketId, loadTicketData]);

  return {
    tickets,
    selectedTicketId,
    setSelectedTicketId,
    events,
    stats,
    loading,
    wsStatus,
  };
}
