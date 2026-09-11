import Balances from "./components/Balances.jsx";
import Positions from "./components/Positions.jsx";
import Orders from "./components/Orders.jsx";
import TradingBot from "./components/TradingBot.jsx";

export default function App() {
  return (
    <div className="app">
      <header>
        <h1>OKX Futures Dashboard</h1>
        <p className="subtitle">Live account data · real funds</p>
      </header>
      <main>
        <Balances />
        <Positions />
        <Orders />
        <TradingBot />
      </main>
    </div>
  );
}
