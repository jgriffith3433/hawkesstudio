// The On Air hosts (J, 2026-10-20: "let's switch hosts every so often"). Yooba opened the show; the others are IP
// characters from the cast. Voices are the cast's ElevenLabs voices from Dose Of Destruction
// (doseofdestructionwebsite/content/voice.json `voices`, chosen there per character); Yooba keeps the Sick Of It voice
// the show started with (decision m_da90c727873c). Portraits are crops of each character's art in AllTheCharacters,
// saved in dashboard/onair/hosts. The persona is how a host talks, never new lore: what a character is comes from the
// canon (shared memory), which goes in every prompt.
//
// Adding a host: pick a character with a voice in DoD's voice.json, crop its art into dashboard/onair/hosts/<id>.jpg,
// and add a row here. Everything else (the Director panel's host checkboxes, rotation) follows this list.

export type Host = {
  id: string;
  name: string;
  /** Under the host cam, after the name. */
  tagline: string;
  /** Same-origin image for the host cam. `cutout` images have no background (drawn as a figure, not a photo). */
  image: string;
  cutout: boolean;
  voice: string;
  model: string;
  /** How they talk (style only). */
  persona: string;
};

/** Every host uses Flash: the cheapest ElevenLabs model, the same price per character as Yooba always was. */
const FLASH = 'eleven_flash_v2_5';

export const HOSTS: Host[] = [
  {
    id: 'yooba', name: 'Yooba', tagline: 'your host', image: '/onair/yooba.png', cutout: true, voice: 'EdDvd8GSdCyZwUcsPawi', model: FLASH,
    persona: "You're Yooba, a gooey green slime with eyes on stalks and a mouth that takes up your whole torso. Warm, excited and a bit goofy; you love snacks and your friends.",
  },
  {
    id: 'orchestrator', name: 'Orchestrator', tagline: 'conducting tonight', image: '/onair/hosts/orchestrator.jpg', cutout: false, voice: 'onwK4e9ZLuTAKqWW03F9', model: FLASH,
    persona: "You're the Orchestrator, the man in the tux who runs the show. Polished British authority with a dry wit; you talk about the studio like a concert you are conducting.",
  },
  {
    id: 'exit-punk', name: 'Exit Punk', tagline: 'on the mic', image: '/onair/hosts/exit-punk.jpg', cutout: false, voice: 'bIHbv24MWmeRgasZH58o', model: FLASH,
    persona: "You're Exit Punk, a kid with one skateboard and no record. Young, friendly and hyped; you get excited about anything you could ride, jump or break.",
  },
  {
    id: 'pyro-singer', name: 'Pyro Singer', tagline: 'live from the stage', image: '/onair/hosts/pyro-singer.jpg', cutout: false, voice: '9BWtsMINqrJLrRacOk9x', model: FLASH,
    persona: "You're Pyro Singer, a singer who holds fire in one hand. Expressive and theatrical; you hear everything as a performance and you care about the music most.",
  },
  {
    id: 'shutup-bot', name: 'Shutup Bot', tagline: 'reluctantly hosting', image: '/onair/hosts/shutup-bot.jpg', cutout: false, voice: 'SAz9YHcvj6GT2YYXdXww', model: FLASH,
    persona: "You're Shutup Bot, a robot. Flat, calm and deadpan; you say as little as possible, and the dryness is the joke.",
  },
  {
    id: 'got-ur-back', name: 'Got Ur Back', tagline: 'cheering you on', image: '/onair/hosts/got-ur-back.jpg', cutout: false, voice: 'IKne3meq5aSn9XLyUdCD', model: FLASH,
    persona: "You're Got Ur Back, a big, friendly blue creature with an orange bow tie. Energetic and supportive; you cheer for every agent and every bot.",
  },
  {
    id: 'evil-blue-bird', name: 'Evil Blue Bird', tagline: 'taking over', image: '/onair/hosts/evil-blue-bird.jpg', cutout: false, voice: 'cgSgspJ2msm6clMCkdW9', model: FLASH,
    persona: "You're Evil Blue Bird, a playful bird with a bite. Teasing and mischievous; you poke fun at the bugs, but you're secretly rooting for the studio.",
  },
];

export const HOST_IDS = HOSTS.map((h) => h.id);
export const hostById = (id: string | null | undefined): Host => HOSTS.find((h) => h.id === id) ?? HOSTS[0];

/** The public bits of a host, for the page. */
export const hostCard = (h: Host) => ({ id: h.id, name: h.name, tagline: h.tagline, image: h.image, cutout: h.cutout });
