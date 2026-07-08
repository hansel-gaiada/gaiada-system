// Surface router: one send interface over both chat surfaces. Chat ids carry their
// surface (`tg:` prefix = Telegram, else WhatsApp), so digests and replies always leave
// through the surface the chat lives on — Telegram keeps working when WAHA is down.
import { WahaGateway, type WhatsAppGateway } from "./waha";
import { TelegramGateway } from "./telegram";

export class SurfaceRouter implements WhatsAppGateway {
  constructor(
    private wa: WhatsAppGateway = new WahaGateway(),
    private tg: WhatsAppGateway = new TelegramGateway(),
  ) {}

  async sendText(chatId: string, text: string): Promise<void> {
    if (chatId.startsWith("tg:")) return this.tg.sendText(chatId, text);
    return this.wa.sendText(chatId, text);
  }
}
