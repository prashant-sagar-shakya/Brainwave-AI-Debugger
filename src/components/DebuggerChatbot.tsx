"use client";
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { CopyToClipboard } from "react-copy-to-clipboard";
import AWS from "aws-sdk";
import { useUser } from "@clerk/clerk-react";
import { FaHistory, FaExclamationTriangle, FaSpinner } from "react-icons/fa";
import { ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { debounce, throttle } from "lodash";

// Interfaces removed as they are TypeScript specific

const AWS_CONFIG = {
  region: import.meta.env.VITE_AWS_REGION || "ap-south-1",
  accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
  lambdaFunction: import.meta.env.VITE_AWS_LAMBDA_FUNCTION_NAME || "",
};

const MOCK_LOGS = [
  "[INFO] Test log message 1",
  "[ERROR] Test error message",
  "[WARN] Test warning message",
  "[INFO] Test log message 2",
  "[DEBUG] Test debug message",
];

AWS.config.update(AWS_CONFIG);
const lambda = new AWS.Lambda({
  maxRetries: 3,
  httpOptions: { timeout: 30000 },
});

const DebuggerChatbot = ({ params }) => {
  // Removed : Props type annotation
  const { user } = useUser();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showMetrics, setShowMetrics] = useState(true);
  const [cloudWatchLogs, setCloudWatchLogs] = useState([]); // Removed <string[]> type
  const [searchTerm, setSearchTerm] = useState("");
  const [searchHistory, setSearchHistory] = useState([]); // Removed <string[]> type
  const [messages, setMessages] = useState([]); // Removed <ChatMessage[]> type
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [chatSessions, setChatSessions] = useState([]); // Removed <ChatSession[]> type
  const [currentSessionId, setCurrentSessionId] = useState("");
  const [metrics, setMetrics] = useState({
    // Removed <Metrics> type
    logEvents: 0,
    errors: 0,
    throttled: 0,
  });
  const [deletingId, setDeletingId] = useState(null); // Removed <string | null> type

  const messagesEndRef = useRef(null); // Removed <HTMLDivElement> type
  const abortControllerRef = useRef(null); // Removed <AbortController | null> type

  const createNewSession = () => ({
    // Removed return type : ChatSession
    id: uuidv4(),
    name: "New Chat",
    timestamp: Date.now(),
    messages: [],
    searchHistory: [],
    isNew: true,
  });

  const generateSessionTitle = (messages) => {
    // Removed parameter type : ChatMessage[] and return type : string
    const firstMessage = messages.find((m) => m.sender === "user");
    return (
      firstMessage?.text.substring(0, 50) +
        (firstMessage?.text.length > 50 ? "..." : "") || "New Chat"
    );
  };

  const handleError = useCallback((error) => {
    // Removed parameter type : unknown
    let errorMessage = "An unexpected error occurred";
    if (error instanceof Error) {
      errorMessage = error.message;
      if (error.name === "TimeoutError") {
        errorMessage = "Request timed out. Please try again.";
      }
    }
    setError(errorMessage);
    console.error("Error:", error);
    setTimeout(() => setError(""), 10000);
  }, []);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const toggleMetrics = useCallback(() => setShowMetrics((prev) => !prev), []);

  const updateSearchHistory = useMemo(
    () =>
      debounce((term) => {
        // Removed parameter type : string
        setSearchHistory((prev) => [
          term,
          ...prev.filter((t) => t !== term).slice(0, 9),
        ]);
      }, 500),
    []
  );

  const persistSessions = useCallback(
    (sessions) => {
      // Removed parameter type : ChatSession[]
      try {
        localStorage.setItem("chatSessions", JSON.stringify(sessions));
      } catch (err) {
        handleError("Failed to save chat history");
      }
    },
    [handleError]
  );

  const switchSession = (sessionId) => {
    // Removed parameter type : string
    setCurrentSessionId(sessionId);
    const session = chatSessions.find((s) => s.id === sessionId);
    setMessages(session?.messages || []);
    setSearchHistory(session?.searchHistory || []);
  };

  const deleteChatSession = async (sessionId) => {
    // Removed parameter type : string
    if (!confirm("Are you sure you want to delete this chat?")) return;

    try {
      setDeletingId(sessionId);

      // Delete from database if user is logged in
      if (user) {
        await fetch(
          `${import.meta.env.VITE_API_URL}/api/users/chat/${sessionId}`,
          {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
          }
        );
      }

      // Delete locally
      setChatSessions((prev) =>
        prev.filter((session) => session.id !== sessionId)
      );

      // If deleting current session, switch to a new one
      if (sessionId === currentSessionId) {
        const newSession = createNewSession();
        setChatSessions((prev) => [newSession, ...prev]);
        switchSession(newSession.id);
      }
    } catch (err) {
      handleError(
        err instanceof Error ? err : new Error("Failed to delete chat")
      );
    } finally {
      setDeletingId(null);
    }
  };

  const handleNewChat = () => {
    // Generate title for current session
    const currentSession = chatSessions.find((s) => s.id === currentSessionId);
    if (currentSession?.messages.length) {
      setChatSessions((prev) =>
        prev.map((session) => {
          if (session.id === currentSessionId) {
            return {
              ...session,
              name: generateSessionTitle(session.messages),
              isNew: false,
            };
          }
          return session;
        })
      );
    }

    // Create new session
    const newSession = createNewSession();
    setChatSessions((prev) => [newSession, ...prev]);
    switchSession(newSession.id);
  };

  const fetchCloudWatchMetrics = useCallback(async () => {
    try {
      if (import.meta.env.VITE_TEST_MODE === "true") {
        return { logEvents: 100, errors: 5, throttled: 2 };
      }
      const cloudwatch = new AWS.CloudWatch();
      const now = new Date();
      const startTime = new Date(now.getTime() - 86400000);
      const [logEventsData, errorsData, throttledData] = await Promise.all([
        cloudwatch
          .getMetricStatistics({
            Namespace: "AWS/Logs",
            MetricName: "IncomingLogEvents",
            Dimensions: [
              {
                Name: "LogGroupName",
                Value: `/aws/lambda/${AWS_CONFIG.lambdaFunction}`,
              },
            ],
            StartTime: startTime,
            EndTime: now,
            Period: 86400,
            Statistics: ["Sum"],
          })
          .promise(),
        cloudwatch
          .getMetricStatistics({
            Namespace: "AWS/Logs",
            MetricName: "ErrorCount",
            Dimensions: [
              {
                Name: "LogGroupName",
                Value: `/aws/lambda/${AWS_CONFIG.lambdaFunction}`,
              },
            ],
            StartTime: startTime,
            EndTime: now,
            Period: 86400,
            Statistics: ["Sum"],
          })
          .promise(),
        cloudwatch
          .getMetricStatistics({
            Namespace: "AWS/Logs",
            MetricName: "ThrottledRecords",
            Dimensions: [
              {
                Name: "LogGroupName",
                Value: `/aws/lambda/${AWS_CONFIG.lambdaFunction}`,
              },
            ],
            StartTime: startTime,
            EndTime: now,
            Period: 86400,
            Statistics: ["Sum"],
          })
          .promise(),
      ]);
      return {
        logEvents: logEventsData.Datapoints?.[0]?.Sum || 0,
        errors: errorsData.Datapoints?.[0]?.Sum || 0,
        throttled: throttledData.Datapoints?.[0]?.Sum || 0,
      };
    } catch (err) {
      handleError(err);
      return { logEvents: 0, errors: 0, throttled: 0 };
    }
  }, [handleError]);

  const fetchCloudWatchLogs = useCallback(async () => {
    try {
      abortControllerRef.current?.abort();
      abortControllerRef.current = new AbortController();
      if (import.meta.env.VITE_TEST_MODE === "true") {
        setCloudWatchLogs(MOCK_LOGS);
        return;
      }
      const cloudwatch = new AWS.CloudWatchLogs();
      const data = await cloudwatch
        .filterLogEvents({
          logGroupName: `/aws/lambda/${AWS_CONFIG.lambdaFunction}`,
          limit: 10,
          startTime: Date.now() - 3600000,
          interleaved: true,
        })
        .promise();
      const logs = data.events?.map((e) => e.message) || [];
      setCloudWatchLogs(logs);
    } catch (err) {
      if (err.name !== "AbortError") handleError(err); // Removed type assertion (err as Error)
    }
  }, [handleError]);

  const handleSearch = useMemo(
    () =>
      throttle(async (term) => {
        // Removed parameter type : string
        if (!term.trim()) return;
        try {
          setLoading(true);
          setError("");
          setSearchTerm("");
          const newMessage = {
            // Removed type annotation : ChatMessage
            id: uuidv4(),
            sender: "user",
            text: term,
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, newMessage]);

          // Save message to database
          if (user) {
            try {
              const response = await fetch(
                `${import.meta.env.VITE_API_URL}/api/users/chat`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    userId: user.id,
                    message: newMessage,
                    sessionId: currentSessionId,
                  }),
                }
              );
              if (!response.ok) throw new Error("Failed to save message");
            } catch (err) {
              console.error("Error saving message:", err);
              handleError(err);
            }
          }
          const response = await lambda
            .invoke({
              FunctionName: AWS_CONFIG.lambdaFunction,
              InvocationType: "RequestResponse",
              Payload: JSON.stringify({
                body: JSON.stringify({ prompt: term }),
              }),
            })
            .promise();
          if (response.FunctionError)
            throw new Error(`Lambda Error: ${response.Payload}`);

          const result = JSON.parse(response.Payload); // Removed type : LambdaResponse and assertion as string
          if (result.statusCode >= 400)
            throw new Error(result.error || "Lambda invocation failed");
          const responseData = JSON.parse(result.body);
          const awsResponse = responseData.response || "No response from AWS";
          const responseMessage = {
            // Removed type annotation : ChatMessage
            id: uuidv4(),
            sender: "aws",
            text: awsResponse,
            isMarkdown: awsResponse.includes("```"),
            timestamp: Date.now(),
          };
          setMessages((prev) => [...prev, responseMessage]);
          updateSearchHistory(term);
        } catch (err) {
          handleError(err);
        } finally {
          setLoading(false);
          scrollToBottom();
        }
      }, 1000),
    [handleError, scrollToBottom, updateSearchHistory, user, currentSessionId]
  );

  // Load chat sessions from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chatSessions");
      if (saved) {
        const parsed = JSON.parse(saved);
        setChatSessions(parsed);
        if (parsed.length > 0) {
          switchSession(parsed[0].id);
        } else {
          const newSession = createNewSession();
          setChatSessions([newSession]);
          switchSession(newSession.id);
        }
      } else {
        const newSession = createNewSession();
        setChatSessions([newSession]);
        switchSession(newSession.id);
      }
    } catch (err) {
      handleError("Failed to load chat history");
      const newSession = createNewSession();
      setChatSessions([newSession]);
      switchSession(newSession.id);
    }
  }, [handleError]); // Note: Added handleError dependency based on usage

  // Update session when messages/searchHistory change
  useEffect(() => {
    setChatSessions((prev) =>
      prev.map((session) => {
        if (session.id === currentSessionId) {
          return {
            ...session,
            messages,
            searchHistory,
            isNew: messages.length > 0 ? false : session.isNew,
          };
        }
        return session;
      })
    );
  }, [messages, searchHistory, currentSessionId]);

  // Persist sessions when they change
  useEffect(() => {
    persistSessions(chatSessions);
  }, [chatSessions, persistSessions]);

  // Fetch metrics and logs
  useEffect(() => {
    const fetchAll = async () => {
      const metricsData = await fetchCloudWatchMetrics();
      setMetrics(metricsData);
      await fetchCloudWatchLogs();
    };
    fetchAll();
    const interval = setInterval(fetchAll, 30000);
    return () => {
      clearInterval(interval);
      abortControllerRef.current?.abort();
    };
  }, [fetchCloudWatchMetrics, fetchCloudWatchLogs]);

  // Cleanup effect
  useEffect(() => {
    return () => {
      updateSearchHistory.cancel();
      handleSearch.cancel();
    };
  }, [updateSearchHistory, handleSearch]);

  const renderMessage = useCallback(
    (
      message // Removed parameter type : ChatMessage
    ) => (
      <ErrorBoundary key={message.id}>
        <div
          className={`flex items-center ${
            message.sender === "user" ? "justify-end" : "justify-start"
          } mb-4`}
        >
          <img
            src={
              message.sender === "user"
                ? user?.imageUrl
                : "https://cdn0.iconfinder.com/data/icons/social-flat-rounded-rects/512/aws-512.png"
            }
            alt={message.sender}
            className="rounded-full w-10 h-10 mx-2 object-cover"
          />
          <div
            className={`p-4 rounded-xl max-w-3xl ${
              message.sender === "user" ? "bg-blue-700" : "bg-gray-800"
            }`}
          >
            {message.isMarkdown ? (
              <ReactMarkdown
                components={{
                  code({ node, className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || "");
                    return match ? (
                      <div className="relative">
                        <SyntaxHighlighter
                          style={dark}
                          language={match[1]}
                          PreTag="div"
                          customStyle={{ backgroundColor: "#2d2d2d" }}
                        >
                          {String(children).replace(/\n$/, "")}
                        </SyntaxHighlighter>
                        <CopyToClipboard
                          text={String(children)}
                          onCopy={() => setCopied(true)}
                        >
                          <button className="absolute top-2 right-2 bg-blue-600 text-white px-3 py-1 rounded-md">
                            {copied ? "Copied!" : "Copy"}
                          </button>
                        </CopyToClipboard>
                      </div>
                    ) : (
                      <code
                        className="bg-gray-300 px-1.5 py-0.5 rounded-sm"
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {message.text}
              </ReactMarkdown>
            ) : (
              <div className="text-gray-100 whitespace-pre-wrap">
                {message.text}
              </div>
            )}
          </div>
        </div>
      </ErrorBoundary>
    ),
    [copied, user?.imageUrl]
  );

  return (
    <div className="flex flex-col lg:flex-row bg-gray-900 text-gray-100">
      {/* Kept the style tag exactly as provided */}
      <style jsx="true" global="true">{`
        .deepseek-scroll {
          scrollbar-width: none;
          -ms-overflow-style: none;
        }
        .deepseek-scroll::-webkit-scrollbar {
          display: none;
        }
        @media (max-width: 768px) {
          .min-h-screen {
            flex-direction: column;
          }
          .lg\:flex-row {
            flex-direction: column;
          }
          .lg\:w-1\/4 {
            width: 100%;
          }
          .lg\:w-1\/2 {
            width: 100%;
          }
          .lg\:w-3\/4 {
            width: 100%;
          }
          .lg\:block {
            display: block;
          }
          .lg\:hidden {
            display: none;
          }
        }
      `}</style>

      {/* Toggle Button */}
      <button
        onClick={toggleMetrics}
        className={`hidden lg:flex items-center justify-center absolute top-1/2 -translate-y-1/2 z-30
          ${showMetrics ? "left-[calc(25%-12px)]" : "left-0"}
          w-6 h-12 bg-gray-800 hover:bg-gray-700 rounded-r-lg`}
      >
        {showMetrics ? (
          <ChevronLeft className="w-4 h-4 text-gray-300" />
        ) : (
          <ChevronRight className="w-4 h-4 text-gray-300" />
        )}
      </button>

      {/* Metrics Panel */}
      {showMetrics && (
        <div className="w-full lg:w-1/4 border-b lg:border-r border-gray-700 p-4 flex flex-col h-[calc(100vh-4rem)] overflow-hidden transition-all duration-300">
          <h3 className="text-lg font-semibold mb-4">CloudWatch Metrics</h3>
          <div className="bg-gray-800/50 rounded-lg p-4 mb-4 overflow-y-auto max-h-60 deepseek-scroll">
            <h4 className="text-sm font-medium mb-2">Last 24 Hours</h4>
            <div className="grid grid-cols-3 gap-2 overflow-y-auto max-h-52 deepseek-scroll">
              <div className="bg-gray-700/50 p-2 rounded">
                <p className="text-xs text-gray-400">Log Events</p>
                <p className="text-lg font-bold">{metrics.logEvents}</p>
              </div>
              <div className="bg-gray-700/50 p-2 rounded">
                <p className="text-xs text-gray-400">Errors</p>
                <p className="text-lg font-bold">{metrics.errors}</p>
              </div>
              <div className="bg-gray-700/50 p-2 rounded">
                <p className="text-xs text-gray-400">Throttled</p>
                <p className="text-lg font-bold">{metrics.throttled}</p>
              </div>
            </div>
          </div>

          <h3 className="text-lg font-semibold mb-4">Recent Logs</h3>
          <div className="flex-1 overflow-y-auto space-y-2 h-[calc(100vh-4rem)] deepseek-scroll">
            {cloudWatchLogs.map((log, i) => (
              <div
                key={i}
                className={`p-2 rounded text-sm font-mono ${
                  log.includes("ERROR") ? "bg-red-900/50" : "bg-gray-800/50"
                }`}
              >
                {log}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Chat Area */}
      <div
        className={`flex-1 flex flex-col h-[calc(100vh-4rem)] overflow-hidden ${
          showMetrics ? "lg:w-1/2" : "lg:w-3/4"
        }`}
      >
        <div className="p-4 border-b border-gray-700 flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-4">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch(searchTerm)}
            placeholder="Ask AWS Debugger..."
            className="flex-1 bg-gray-800 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => handleSearch(searchTerm)}
            disabled={loading}
            className="bg-blue-600 px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center"
          >
            {loading ? (
              <>
                <FaSpinner className="animate-spin mr-2" />
                Asking...
              </>
            ) : (
              "Ask"
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6 deepseek-scroll h-[calc(100vh-4rem)]">
          {messages.map(renderMessage)}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* History Sidebar */}
      <div
        className={`w-full lg:w-1/4 border-t lg:border-l border-gray-700 p-4 ${
          isSidebarOpen ? "block" : "hidden"
        } lg:block overflow-hidden overflow-y-auto p-4 space-y-6 deepseek-scroll h-[calc(100vh-4rem)]`}
      >
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold">Chat History</h3>
          <button
            onClick={handleNewChat}
            className="w-[130px] text-center p-2 bg-orange-400 rounded-full hover:bg-orange-500 transition-colors text-white"
          >
            New Chat
          </button>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="lg:hidden text-gray-400 hover:text-white"
          >
            ×
          </button>
        </div>
        <div className="space-y-2 overflow-y-auto h-[calc(100vh-4rem)] overflow-hidden">
          {chatSessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center justify-between w-full p-2 rounded hover:bg-gray-700 transition-colors truncate
                ${
                  session.id === currentSessionId
                    ? "bg-blue-800/50"
                    : "bg-gray-800"
                }`}
            >
              <button
                onClick={() => switchSession(session.id)}
                className="flex-1 text-left truncate"
                title={session.name}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate">{session.name}</span>
                  {session.isNew && (
                    <span className="text-green-400 text-xs">New</span>
                  )}
                </div>
                <div className="text-xs text-gray-400">
                  {new Date(session.timestamp).toLocaleString()}
                </div>
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChatSession(session.id);
                }}
                className="p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Delete chat"
                disabled={deletingId === session.id}
              >
                {deletingId === session.id ? (
                  <FaSpinner className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Mobile Toggle Buttons */}
      <button
        onClick={toggleMetrics}
        className="lg:hidden fixed bottom-16 left-4 bg-gray-800 p-2 rounded-full z-40 transition-all"
      >
        {showMetrics ? (
          <ChevronLeft className="w-5 h-5 text-gray-300" />
        ) : (
          <ChevronRight className="w-5 h-5 text-gray-300" />
        )}
      </button>

      <button
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
        className="fixed bottom-4 right-4 bg-blue-600 p-3 rounded-full lg:hidden z-40"
      >
        <FaHistory className="w-5 h-5" />
      </button>

      {/* Error Toast */}
      {error && (
        <div className="fixed top-4 right-4 bg-red-600 p-4 rounded-lg flex items-center space-x-2 z-50">
          <FaExclamationTriangle />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
};

// Removed type annotation from ErrorBoundary props
class ErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    // Removed parameter type : Error
    console.error("Component Error:", error);
  }
  render() {
    return this.state.hasError ? (
      <div className="bg-red-900/50 p-4 rounded-lg flex items-center space-x-2">
        <FaExclamationTriangle />
        <span>Component failed to load</span>
      </div>
    ) : (
      this.props.children
    );
  }
}

export default DebuggerChatbot;
