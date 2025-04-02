import DebuggerChatbot from "./DebuggerChatbot";

function AppLayout() {
  const paddingTopClass = "pt-20";

  return (
    <div className="text-[rgb(17,24,39)] flex flex-col h-screen bg-[rgb(17,24,39)] overflow-hidden relative">
      <main className={`flex-1 ${paddingTopClass} overflow-hidden`}>
        <DebuggerChatbot />
      </main>
    </div>
  );
}

export default AppLayout;
