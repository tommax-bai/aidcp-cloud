/** Fixed intent-selection probability for Facebook videos presented in Feed/Reels. */
export const FACEBOOK_PRESENTED_VIDEO_LIKE_PROBABILITY = 0.25;
/** Backward-compatible public name used by existing Reels tests/callers. */
export const FACEBOOK_REELS_LIKE_PROBABILITY = FACEBOOK_PRESENTED_VIDEO_LIKE_PROBABILITY;

/**
 * Normalize supported Facebook post/video URLs to their globally unique post id.
 * Unknown shapes retain their original value so they never collapse onto one another.
 */
export function facebookPostKey(noteId: string | undefined | null): string {
  if (!noteId) return '';
  try {
    const url = new URL(noteId, 'https://www.facebook.com/');
    const q =
      url.searchParams.get('multi_permalinks') ||
      url.searchParams.get('story_fbid') ||
      (url.pathname.toLowerCase() === '/watch' || url.pathname.toLowerCase() === '/watch/'
        ? url.searchParams.get('v')
        : null);
    if (q) return q;
    const m = url.pathname.match(/\/(?:posts|videos|reel|permalink)\/([^/?#]+)/i);
    if (m) return m[1];
    return noteId;
  } catch {
    return noteId;
  }
}

function isExactFacebookOrigin(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname.toLowerCase() === 'www.facebook.com';
}

/** Only accepts the canonical identity emitted by the dedicated Reels reader. */
export function isCanonicalFacebookReelNoteId(noteId: string | undefined | null): noteId is string {
  if (!noteId) return false;
  try {
    const url = new URL(noteId);
    return isExactFacebookOrigin(url) && /^\/reel\/[^/?#]+\/?$/i.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Accepts normalized ordinary-Feed post/video identities and explicitly excludes `/reel/`.
 * `isVideo:true` remains the independent presentation witness supplied by Edge.
 */
export function isCanonicalFacebookFeedVideoNoteId(noteId: string | undefined | null): noteId is string {
  if (!noteId) return false;
  try {
    const url = new URL(noteId);
    if (!isExactFacebookOrigin(url) || url.hash || /^\/reel\//i.test(url.pathname)) return false;
    const path = url.pathname;
    if (/^\/watch\/?$/i.test(path)) {
      const keys = [...url.searchParams.keys()];
      return keys.length === 1 && keys[0] === 'v' && /^\d+$/.test(url.searchParams.get('v') ?? '');
    }
    if (
      /\/videos\/[^/?#]+\/?$/i.test(path) ||
      /\/posts\/[^/?#]+\/?$/i.test(path) ||
      /\/permalink\/[^/?#]+\/?$/i.test(path)
    ) {
      return !url.search;
    }
    if (/^\/(?:permalink|story)\.php$/i.test(path)) {
      const id = url.searchParams.get('story_fbid');
      return !!id && [...url.searchParams.keys()].every((key) => key === 'story_fbid' || key === 'id');
    }
    const multi = url.searchParams.get('multi_permalinks');
    return !!multi && [...url.searchParams.keys()].every((key) => key === 'multi_permalinks');
  } catch {
    return false;
  }
}

/**
 * Conservative caption-only exclusion. It catches only explicit high-risk terms; absence of
 * video-frame/audio understanding is handled by the low probability and existing runtime gates.
 */
export function hasObviousHighRiskFacebookCaption(caption: string): boolean {
  const text = caption.normalize('NFKC').toLowerCase();
  return /(?:\bporn(?:ography)?\b|\bnudes?\b|\bsuicide\b|\bbeheading\b|\bcorpse\b|\bcasino\b|\bgambling\b|khiêu dâm|khỏa thân|tự tử|chặt đầu|xác chết|thi thể|máu me|cá cược|đánh bạc|tài xỉu|ma túy|heroin|cocaine|色情|裸照|自杀|斩首|尸体|赌博|毒品)/iu.test(text);
}
