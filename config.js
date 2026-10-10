/* ==========================================================
   BladeLow site: SAB KUCH YAHI SE EDIT HOGA
   Sirf quotes ("...") ke andar ka text badalna. Comma (,) aur
   brackets ({ } [ ]) mat hatana, warna site toot jayegi.
   Link "#" hai matlab abhi placeholder hai, apna real link daal dena.
   ========================================================== */

const SITE = {
  // --- Basic ---
  name: "BladeLow",
  pageTitle: "BladeLow | Minecraft addon dev",
  tagline: "Minecraft Bedrock add-on dev",

  // Profile picture (file ka naam, index.html ke saath same folder me honi chahiye). Khali "" = hata dega.
  avatar: "pfp.jpg",

  // --- Theme colors (apne channel ke colors yahan daal, hex format me) ---
  theme: {
    accent: "#57d13d",  // creeper green: buttons, lines, highlights
    muted: "#9db89a",   // halka text aur borders
    bg: "#0c130e",      // page ka background
    panel: "#15201a",   // cards ka background
    text: "#eef5ec"     // normal text
  },

  // --- Hero ke neeche ke bade buttons ---
  // icon options: "youtube", "instagram", "discord", "curseforge", "link"
  heroButtons: [
    { text: "Join the Discord", url: "https://discord.gg/XcUkm6mMEm", icon: "discord" },
    { text: "Watch on YouTube", url: "https://www.youtube.com/@BladeLow", icon: "youtube" }
  ],

  // --- About section (har item = ek paragraph) ---
  about: [
    "Hey, I'm Sujay, also known as BladeLow! I'm a student, content creator, and tech enthusiast who loves Minecraft, coding, game development, and video editing. I enjoy experimenting with new ideas and turning my creativity into something unique.",
    ""
  ],

  // --- Social links (naya add karna ho to ek { } block copy karke paste kar) ---
  socials: [
    { name: "YouTube", url: "https://www.youtube.com/@BladeLow", note: "Videos, edits and tutorials", icon: "youtube" },
    { name: "Instagram", url: "https://www.instagram.com/_bladelow_/", note: "Updates and reels", icon: "instagram" },
    { name: "Discord", url: "https://discord.gg/XcUkm6mMEm", note: "Live chat community", icon: "discord" },
    { name: "CurseForge", url: "curseforge.com/members/bladelow/projects", note: "Download my addons", icon: "curseforge" }
  ],

  // --- Stats (Home page pe numbers) ---
  stats: {
    // Manual numbers: auto-fetch fail ho ya setup na ho to ye dikhenge. Khali "" = chhup jayega.
    subscribers: "700+",   // abhi ka number, kabhi kabhi khud update kar dena
    discordMembers: "50+",

    // Subscriber goal: progress bar dikhayega (jaise "Road to 1K"). Nahi chahiye to 0 ya "" kar de.
    goal: 1000,

    // YouTube auto subscribers (optional): Google Cloud Console me free "YouTube Data API v3" key bana.
    // Key ko "HTTP referrers" se restrict kar de: https://tumharausername.github.io/*
    youtubeApiKey: "",

    // Discord auto members (optional): invite link ka last part. Example: discord.gg/abc123 -> "abc123"
    // Invite "Never expire" wala hona chahiye.
    discordInviteCode: "XcUkm6mMEm"
  },

   discordServerId: "1460962421073117246",
redditUrl: "https://www.reddit.com/r/BladeLow",
team: [
  { name: "BladeLow", role: "Owner" }
],
  // --- Addons / projects (CurseForge links yahan) ---
  addons: [
    {
      name: "BytePlayer",
      desc: "BytePlayer is a Minecraft Bedrock addon that simulates the experience of being one block tall with a lowered first-person camera, multiple camera modes, and reduced jump height, creating a fresh and immersive survival experience.",
      url: "https://www.curseforge.com/minecraft-bedrock/addons/byteplayer",
       
      name: "Better Flight System",
      desc: "This addon adds a smooth flight system with tilt camera, speed-based FOV, and immersive flying experience using elytra. Inspired by barrel roll mechanics.",
      url: "https://www.curseforge.com/minecraft-bedrock/addons/better-flight-system",
       
      name: "Better Transport",
      desc: "Better Transport allows players to pick up and carry mobs using a smooth and simple system.",
      url: "https://www.curseforge.com/minecraft-bedrock/addons/better-transport",
       
      name: "More logs add-on",
      desc: "More real trees",
      url: "https://www.curseforge.com/minecraft-bedrock/addons/more-logs-add-on",
       
      name: "Block of sky for bedrock",
      desc: "This add-on adds two new blocks called block of sky and block of sun",
      url: "https://www.curseforge.com/minecraft-bedrock/addons/block-of-sky-for-bedrock"
    }
    // Naya addon: upar wale block ke baad comma laga ke ek aur { name:"", desc:"", url:"" } daal de
  ],

  // --- Upcoming content plans ---
  // status me kuch bhi likh sakta hai: "Planning", "In progress", "Done"
  upcoming: [
    { title: "New addon that will make your minecraft bedrock feel new", status: "Working on", desc: "20% done" }
  ],

  // --- Latest YouTube video (apne aap update hota hai) ---
  // Channel ID: YouTube Studio > Settings > Channel > Advanced settings. "UC" se shuru hota hai.
  // Khali chhodega to ye section chhup jayega.
  youtubeChannelId: "UCb7oD9VTPrQcb0mCj5MJHNA",

  // --- Community tab ---
  discordInvite: "https://discord.gg/XcUkm6mMEm",
  communityText: "Chat with other creators, get updates first and hang out on Discord.",

  // --- Ideas tab (Reddit jaisa discussion, GitHub Discussions pe chalta hai) ---
  ideasIntro: "Got an idea for my next video, addon or project? Post it here and discuss it with others. You need a free GitHub account to post.",

  // Giscus setup: https://giscus.app pe jaa, apna repo daal, jo 4 values mile wo yahan paste kar.
  // Khali chhodega to Ideas tab me setup ka message dikhega.
  giscus: {
    repo: "bladelow/bladelow.github.io",       // example: "sujaydhara654-jpg/sujaydhara654-jpg.github.io"
    repoId: "R_kgDOVDxKAA",
    category: "Announcements",   // example: "Ideas"
    categoryId: "DIC_kwDOVDxKAM4DHf3G"
  },

  footer: "Made by BladeLow"
};
