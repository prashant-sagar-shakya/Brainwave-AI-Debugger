import {
  discordBlack,
  facebook,
  file02,
  homeSmile,
  instagram,
  notification2,
  notification3,
  notification4,
  plusSquare,
  searchMd,
  telegram,
  twitter,
} from "../assets";

export const navigation = [
  {
    id: "0",
    title: "New account",
    url: "#signup", // clerk authentication needed
    onlyMobile: true,
  },
  {
    id: "1",
    title: "Sign in",
    url: "#login", // clerk authentication needed
    onlyMobile: true,
  },
];

export const heroIcons = [homeSmile, file02, searchMd, plusSquare];

export const notificationImages = [notification4, notification3, notification2];

export const socials = [
  {
    id: "0",
    title: "Discord",
    iconUrl: discordBlack,
    url: "https://discord.com/",
  },
  {
    id: "1",
    title: "Twitter",
    iconUrl: twitter,
    url: "https://twitter.com/",
  },
  {
    id: "2",
    title: "Instagram",
    iconUrl: instagram,
    url: "https://www.instagram.com/",
  },
  {
    id: "3",
    title: "Telegram",
    iconUrl: telegram,
    url: "https://t.me/",
  },
  {
    id: "4",
    title: "Facebook",
    iconUrl: facebook,
    url: "https://www.facebook.com/",
  },
];
