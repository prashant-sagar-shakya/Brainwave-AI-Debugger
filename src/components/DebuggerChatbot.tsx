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
import { ChevronLeft, ChevronRight } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { debounce, throttle } from "lodash";

interface ChatMessage {
  id: string;
  sender: "user" | "aws";
  text: string;
  isMarkdown?: boolean;
  timestamp: number;
}

interface ServerResponse {
  statusCode: number;
  body: string;
  error?: string;
}

interface ChatHistoryResponse {
  chatHistory: ChatMessage[];
}

interface ChatSession {
  id: string;
  name: string;
  timestamp: number;
  messages: ChatMessage[];
  searchHistory: string[];
}

interface LambdaResponse {
  statusCode: number;
  body: string;
  error?: string;
}

interface Props {
  params: { subaccountId: string };
}

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

const DebuggerChatbot = ({ params }: Props) => {
  const { user } = useUser();
  interface Metrics {
    logEvents: number;
    errors: number;
    throttled: number;
  }

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showMetrics, setShowMetrics] = useState(true);
  const [cloudWatchLogs, setCloudWatchLogs] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>(uuidv4());
  const [metrics, setMetrics] = useState<Metrics>({
    logEvents: 0,
    errors: 0,
    throttled: 0,
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleError = useCallback((error: unknown) => {
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
      debounce((term: string) => {
        setSearchHistory((prev) => [
          term,
          ...prev.filter((t) => t !== term).slice(0, 9),
        ]);
      }, 500),
    []
  );

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
      if ((err as Error).name !== "AbortError") handleError(err);
    }
  }, [handleError]);

  const handleSearch = useMemo(
    () =>
      throttle(async (term: string) => {
        if (!term.trim()) return;
        try {
          setLoading(true);
          setError("");
          setSearchTerm("");
          const newMessage: ChatMessage = {
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
          const result: LambdaResponse = JSON.parse(response.Payload as string);
          if (result.statusCode >= 400)
            throw new Error(result.error || "Lambda invocation failed");
          const responseData = JSON.parse(result.body);
          const awsResponse = responseData.response || "No response from AWS";
          const responseMessage: ChatMessage = {
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
    [handleError, scrollToBottom, updateSearchHistory, user]
  );

  const persistSessions = useCallback(
    (sessions: ChatSession[]) => {
      try {
        localStorage.setItem("chatSessions", JSON.stringify(sessions));
      } catch (err) {
        handleError("Failed to save chat history");
      }
    },
    [handleError]
  );

  // Load chat sessions from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem("chatSessions");
      if (saved) setChatSessions(JSON.parse(saved));
    } catch (err) {
      handleError("Failed to load chat history");
    }
  }, [handleError]);

  // Fetch chat history when component mounts
  useEffect(() => {
    const fetchChatHistory = async () => {
      if (!user) return;
      try {
        const apiUrl = `${import.meta.env.VITE_API_URL}/api/users/chat/${
          user.clerkId
        }?page=${currentPage}&limit=50`;
        if (!apiUrl.startsWith("http")) {
          throw new Error(`Invalid API URL: ${apiUrl}`);
        }

        const response = await fetch(apiUrl);
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to fetch chat history: ${errorText}`);
        }

        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
          // If we got HTML, it's likely a wrong URL or server error
          if (contentType?.includes("text/html")) {
            throw new Error(
              "Server returned HTML instead of JSON. Check API URL configuration."
            );
          }
          const text = await response.text();
          throw new Error(`Expected JSON but got: ${contentType || "unknown"}`);
        }

        const data = await response.json();
        setMessages(data.messages || []);
        setTotalPages(data.totalPages || 1);
      } catch (err) {
        console.error("Error fetching chat history:", err);
        handleError(err instanceof Error ? err : new Error(String(err)));
      }
    };
    fetchChatHistory();
  }, [user, currentPage, handleError]);

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
    (message: ChatMessage) => (
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
            onClick={() => {
              setMessages([]);
            }}
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
          {searchHistory.map((term, i) => (
            <button
              key={i}
              onClick={() => setSearchTerm(term)}
              className="w-full text-left p-2 bg-gray-800 rounded hover:bg-gray-700 transition-colors"
            >
              {term}
            </button>
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

class ErrorBoundary extends React.Component<{ children: React.ReactNode }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
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
