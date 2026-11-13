/** @type {import("./registry.js").Scenario[]} */
export default [
  {
    id: "recovery/create",
    area: "Recovery",
    title: "Create a password recovery file",
    url: "/recover",
    check: [
      "The card sits centred with a clear heading and one-line explanation",
      "Who is it for? shows six compact choices; one existing account reveals Username",
      "Turning off This Luna has a device token hides the token field and shortens the file name",
      "Set a new password validates length and matching passwords inline",
      "Download recovery file downloads the file and says so",
      "How to use the recovery file opens and closes",
    ],
  },
  {
    id: "recovery/phone-dark",
    area: "Recovery",
    title: "Recovery file page on a phone, dark",
    url: "/recover",
    viewport: "phone",
    theme: "dark",
    check: [
      "Nothing scrolls sideways; the account choices stack",
      "Every label and field is readable on the dark card",
      "Download stays reachable at the bottom",
    ],
  },
];
