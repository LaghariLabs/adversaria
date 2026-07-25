import { useState, useCallback, useEffect } from "react";
import { getConfig, updateConfig } from "../lib/tauri";
import type { AppConfig } from "../types";

interface UseConfigReturn {
  config: AppConfig | null;
  loading: boolean;
  save: (partial: Partial<AppConfig>) => Promise<void>;
  reload: () => Promise<void>;
}

export function useConfig(): UseConfigReturn {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await getConfig();
      setConfig(cfg);
    } catch (e) {
      console.error("Failed to load config:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  const save = useCallback(
    async (partial: Partial<AppConfig>) => {
      if (!config) return;
      // The Rust command deserializes a full AppConfig, so merge first.
      const merged = { ...config, ...partial };
      await updateConfig(merged);
      setConfig(merged);
    },
    [config],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  return { config, loading, save, reload };
}
