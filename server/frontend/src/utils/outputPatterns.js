const DEFAULT_PATTERNS = [
  { match: /docker compose pull/i, message: "Downloading application files..." },
  { match: /docker compose up/i, message: "Starting application services..." },
  { match: /pulling/i, message: "Downloading images..." },
  { match: /created network/i, message: "Setting up networking..." },
  { match: /system-setup/i, message: "Configuring application..." },
  { match: /system-update/i, message: "Updating application..." },
  { match: /system-repair/i, message: "Repairing application..." },
  { match: /waiting for containers/i, message: "Waiting for services to start..." },
  { match: /all containers running/i, message: "All services are running" },
  { match: /install complete/i, message: "Installation complete" },
  { match: /copying/i, message: "Copying files..." },
  { match: /downloading/i, message: "Downloading..." },
  { match: /installing/i, message: "Installing..." },
  { match: /configuring/i, message: "Configuring..." },
  { match: /starting/i, message: "Starting..." },
  { match: /stopped/i, message: "Stopped" },
];

export function getFriendlyMessage(rawLine, customPatterns) {
  const text = rawLine?.content || "";
  const patterns = [...(customPatterns || []), ...DEFAULT_PATTERNS];

  for (const { match, message } of patterns) {
    if (match.test(text)) {
      return message;
    }
  }

  return null;
}

export function getFriendlyMessages(lines, customPatterns) {
  const messages = [];
  let lastMessage = null;

  for (const line of lines) {
    const friendly = getFriendlyMessage(line, customPatterns);
    if (friendly && friendly !== lastMessage) {
      messages.push(friendly);
      lastMessage = friendly;
    }
  }

  return messages;
}
