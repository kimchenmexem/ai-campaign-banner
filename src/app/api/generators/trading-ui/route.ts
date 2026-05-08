import { generateTradingUi } from "@/lib/generators/tradingUi/generateTradingUi";
import { runGenerator } from "@/lib/generators/runGenerator";

// POST /api/generators/trading-ui
// Body: TradingUiParams
export async function POST(request: Request) {
  return runGenerator(request, generateTradingUi);
}
