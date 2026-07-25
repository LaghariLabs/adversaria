interface ErrorBannerProps {
  message: string | null;
  onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps) {
  if (!message) return null;

  return (
    <div
      className="px-4 py-2 bg-red-100 border-b border-red-200 flex items-center justify-between"
      role="alert"
    >
      <span className="text-sm text-red-800 truncate mr-2">{message}</span>
      <button
        onClick={onDismiss}
        className="text-red-700 hover:text-red-900 text-xs font-medium whitespace-nowrap transition-colors"
      >
        Dismiss
      </button>
    </div>
  );
}
