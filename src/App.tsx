import { Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import Estado from "./pages/Estado";
import NotFound from "./pages/NotFound";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/estado" element={<Estado />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
