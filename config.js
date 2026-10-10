/* ==========================================================
   BladeLow site: SAB KUCH YAHI SE EDIT HOGA
   Sirf quotes ("...") ke andar ka text badalna. Comma (,) aur
   brackets ({ } [ ]) mat hatana, warna site toot jayegi.
   Link "#" hai matlab abhi placeholder hai, apna real link daal dena.
   ========================================================== */

const SITE = {
  // --- Basic ---
  name: "BladeLow",
  pageTitle: "BladeLow | Minecraft addons, AI and more",
  tagline: "Minecraft addons, AI projects and experiments. Everything I build lives here.",
  accent: "#5ce1e6", // site ka main color (blade ki chamak). Koi bhi hex color daal sakta hai

  // --- Hero ke neeche ke 2 bade buttons ---
  heroButtons: [
    { text: "Join the Discord", url: "https://discord.gg/XcUkm6mMEm" },
    { text: "Watch on YouTube", url: "https://youtube.com/@BladeLow" }
  ],

  // --- About section (har item = ek paragraph) ---
  about: [
    "I'm Sujay, online as BladeLow. I like building things, not just watching them. Minecraft Bedrock addons, AI tools, Discord bots and desktop apps are my main projects.",
    "This site has all my links, new projects and upcoming content. You can also share your own ideas in the community below."
  ],

  // --- Social links (naya add karna ho to ek { } block copy karke paste kar) ---
  socials: [
    { name: "YouTube", url: "https://youtube.com/@BladeLow", note: "Videos, edits and tutorials" },
    { name: "Instagram", url: "https://www.instagram.com/_bladelow_/", note: "Updates and reels" },
    { name: "Discord", url: "https://discord.gg/XcUkm6mMEm", note: "Live chat community" },
    { name: "CurseForge", url: "www.curseforge.com/members/bladelow/", note: "Download my addons" }
  ],

  // --- Addons / projects (CurseForge links yahan) ---
  addons: [
    {
      name: "Samurai Blades",
      desc: "A samurai-themed Minecraft Bedrock addon. A tameable, rideable samurai dragon is planned.",
      url: "#"
    }
    // Naya addon: upar wale block ke baad comma laga ke ek aur { name:"", desc:"", url:"" } daal de
  ],

  // --- Upcoming content plans ---
  // status me kuch bhi likh sakta hai: "Planning", "In progress", "Done"
  upcoming: [
    { title: "Video essay on perfection", status: "Planning", desc: "A 4-5 minute philosophical video with narration over Minecraft gameplay." },
    { title: "New Minecraft addon", status: "In progress", desc: "Lag-free and built around an original idea." }
  ],

  // --- Latest YouTube video (apne aap update hota hai) ---
  // Channel ID kaise nikaale: YouTube Studio > Settings > Channel > Advanced settings.
  // "UC" se shuru hota hai. Khali chhodega to ye section chhup jayega.
  youtubeChannelId: "UCb7oD9VTPrQcb0mCj5MJHNA",

  // --- Community ---
  discordInvite: "https://discord.gg/XcUkm6mMEm",

  // Giscus = free Reddit jaisa discussion (GitHub Discussions pe chalta hai).
  // Setup: https://giscus.app pe jaa, apna repo daal, jo 4 values mile wo yahan paste kar.
  // Khali chhodega to community box me setup ka message dikhega.
  giscus: {
    repo: "",       // example: "tumharaUsername/tumhara-repo"
    repoId: "",
    category: "",   // example: "Announcements" ya "General"
    categoryId: ""
  },

  footer: "Made by BladeLow"
};
