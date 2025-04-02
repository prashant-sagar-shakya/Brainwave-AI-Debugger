import ButtonGradient from "./assets/svg/ButtonGradient";
import Footer from "./components/Footer";
import Header from "./components/Header";
import Hero from "./components/Hero";
import DebuggerChatbot from "./components/DebuggerChatbot";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/clerk-react";
import { Routes, Route } from "react-router-dom";

const App = () => {
  return (
    <>
      <div className="pt-[4.75rem] lg:pt-[5.25rem] overflow-hidden">
        <Header>
          <SignedOut>
            <SignInButton />
          </SignedOut>
          <SignedIn>
            <UserButton />
          </SignedIn>
        </Header>
        <Routes>
          <Route path="/" element={<Hero />} />
          <Route path="/debugger" element={<DebuggerChatbot />} />
        </Routes>
        {window.location.pathname !== "/debugger" && <Footer />}
      </div>
      <ButtonGradient />
    </>
  );
};

export default App;
