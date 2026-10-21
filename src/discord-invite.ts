/** Extract one unambiguous, official Discord invite from configured messages. */
export function configuredDiscordInvite(messages: readonly string[]): string | undefined {
  const invites = new Set<string>();
  const candidates = messages.flatMap(message => message.match(/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/[A-Za-z0-9-]+|discord\.com\/invite\/[A-Za-z0-9-]+)/giu) || []);

  for (const candidate of candidates) {
    try {
      const url = new URL(/^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`);
      const hostname = url.hostname.toLowerCase().replace(/^www\./u, '');
      const code = hostname === 'discord.gg'
        ? url.pathname.match(/^\/([A-Za-z0-9-]+)$/u)?.[1]
        : hostname === 'discord.com'
          ? url.pathname.match(/^\/invite\/([A-Za-z0-9-]+)$/u)?.[1]
          : undefined;
      if (code) invites.add(hostname === 'discord.gg' ? `https://discord.gg/${code}` : `https://discord.com/invite/${code}`);
    } catch {
      // Ignore malformed URLs in configured chat text.
    }
  }

  return invites.size === 1 ? [...invites][0] : undefined;
}
