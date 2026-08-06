import { useCallback, useEffect, useRef, useState } from "react";

import type { HealthResponse } from "../types";
import { checkServiceHealth, restartLocalAiService } from "../lib/tauri";

/** Four states, deliberately: "degraded" (service up, model server absent) is a
 *  different user problem from "unreachable" (nothing answering at all), and the
 *  Restart Local AI recovery only applies to the latter. */
export type ServiceHealthStatus = "checking" | "ok" | "degraded" | "unreachable";

export interface ServiceHealth {
  health: HealthResponse | null;
  healthStatus: ServiceHealthStatus;
  /** Re-probe now. Stable, so it is safe in an effect's dependency list. */
  checkHealth: () => Promise<void>;
  restartService: () => Promise<void>;
  serviceRestarting: boolean;
  serviceRestartMessage: string;
}

/**
 * The on-device service's health, and the recovery action for it.
 *
 * Extracted from `AiModelTab` so the Setup-status and Transcription sections can
 * both read health without each running its own probe: two consumers calling
 * `check_service_health` independently doubles the traffic and lets them
 * disagree about the same service.
 */
export function useServiceHealth(): ServiceHealth {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthStatus, setHealthStatus] = useState<ServiceHealthStatus>("checking");
  const [serviceRestarting, setServiceRestarting] = useState(false);
  const [serviceRestartMessage, setServiceRestartMessage] = useState("");
  // A restart schedules re-probes seconds later; without this they fire setState
  // after unmount once sections can unmount.
  const timers = useRef<number[]>([]);
  const restarting = useRef(false);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    },
    [],
  );

  const checkHealth = useCallback(async () => {
    try {
      const next = await checkServiceHealth();
      setHealth(next);
      setHealthStatus(next.status === "ok" ? "ok" : "degraded");
    } catch {
      setHealth(null);
      setHealthStatus("unreachable");
    }
  }, []);

  const restartService = useCallback(async () => {
    // Ref, not the state value: a stale closure would let a double-click fire
    // two restarts, and the Rust command rejects a concurrent one with an error
    // the user would see as a failure.
    if (restarting.current) return;
    restarting.current = true;
    setServiceRestarting(true);
    setServiceRestartMessage("");
    try {
      await restartLocalAiService();
      setServiceRestartMessage("Local AI is restarting…");
      // The service binds in ~15 s on a cold start (measured in Windows CI), so
      // one immediate re-probe would always report failure. Two spaced probes.
      timers.current.push(window.setTimeout(() => void checkHealth(), 2_000));
      timers.current.push(window.setTimeout(() => void checkHealth(), 8_000));
    } catch (error) {
      setServiceRestartMessage(String(error));
    } finally {
      restarting.current = false;
      setServiceRestarting(false);
    }
  }, [checkHealth]);

  return {
    health,
    healthStatus,
    checkHealth,
    restartService,
    serviceRestarting,
    serviceRestartMessage,
  };
}
