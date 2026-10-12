import { describe, expect, it } from "vitest";
import { channelDeliveryText, displayName, originCounts, originOf, originSummary, replyHint, sourceLabel } from "./canal";

const base = { fromName: null, fromEmail: "anna@guest.airbnb.com", bookingId: 7 };

describe("messages des canaux", () => {
  it("badge : le nom du canal pour un message Beds24, sinon site ou mail", () => {
    expect(sourceLabel({ channel: "beds24", canal: "Airbnb" })).toEqual({ cls: "canal canal-airbnb", text: "Airbnb" });
    expect(sourceLabel({ channel: "beds24", canal: "Booking.com" })).toEqual({ cls: "canal canal-booking", text: "Booking" });
    expect(sourceLabel({ channel: "beds24", canal: "Vrbo" })).toEqual({ cls: "canal canal-vrbo", text: "Vrbo" });
    expect(sourceLabel({ channel: "beds24", canal: null }).text).toBe("Canal");
    expect(sourceLabel({ channel: "beds24", canal: "Expedia" }).text).toBe("Expedia");
    expect(sourceLabel({ channel: "form", canal: null }).text).toBe("Site");
    expect(sourceLabel({ channel: "email", canal: null }).text).toBe("E-mail");
  });

  it("la réponse à un message de canal part sur le canal, pas par mail", () => {
    expect(replyHint({ ...base, channel: "beds24", canal: "Airbnb" })).toContain("sur Airbnb");
    expect(replyHint({ ...base, channel: "email", canal: null })).toContain("par e-mail à anna@guest.airbnb.com");
    expect(replyHint({ ...base, channel: "email", canal: null, spoofed: true })).toContain("pas de réponse possible");
    expect(replyHint({ ...base, channel: "form", canal: null })).toContain("par mail à anna@guest.airbnb.com");
    expect(channelDeliveryText("beds24", "Airbnb")).toBe("C'est fait. Réponse envoyée sur Airbnb.");
    expect(channelDeliveryText("stub", null)).toBeNull();
  });

  it("jamais l'adresse pseudo beds24:<id> comme nom", () => {
    expect(displayName({ fromName: null, fromEmail: "beds24:999", channel: "beds24", canal: "Vrbo" })).toBe("Voyageur Vrbo");
    expect(displayName({ fromName: "Anna", fromEmail: "x", channel: "beds24", canal: "Airbnb" })).toBe("Anna");
  });

  it("origine : un seul vocabulaire, décompte par origine", () => {
    expect(originOf({ channel: "beds24", canal: "Booking.com" })).toBe("booking");
    expect(originOf({ channel: "beds24", canal: "HomeAway" })).toBe("vrbo");
    expect(originOf({ channel: "beds24", canal: "Expedia" })).toBe("canal");
    const list = [
      { channel: "email", canal: null }, { channel: "email", canal: null }, { channel: "beds24", canal: "Airbnb" },
      { channel: "form", canal: null },
    ] as const;
    expect(originCounts([...list]).map((o) => [o.text, o.n])).toEqual([["E-mail", 2], ["Airbnb", 1], ["Site", 1]]);
    expect(originSummary([...list])).toBe("E-mail 2, Airbnb 1, Site 1");
  });
});
