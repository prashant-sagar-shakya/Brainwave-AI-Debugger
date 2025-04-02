import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus as dark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { CopyToClipboard } from "react-copy-to-clipboard";
import * as AWS from "aws-sdk";
import { useUser } from "@clerk/clerk-react";
import { FaHistory, FaExclamationTriangle, FaSpinner } from "react-icons/fa";
import { ChevronLeft, ChevronRight, Trash2, X } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import { debounce, throttle } from "lodash";

// --- Configuration ---
const AWS_CONFIG = {
  region: import.meta.env.VITE_AWS_REGION || "ap-south-1",
  accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
  secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
  lambdaFunction: import.meta.env.VITE_AWS_LAMBDA_FUNCTION_NAME || "",
};

if (
  !AWS_CONFIG.accessKeyId ||
  !AWS_CONFIG.secretAccessKey ||
  !AWS_CONFIG.lambdaFunction
) {
  console.error(
    "AWS Configuration is missing. Please check your environment variables (VITE_AWS_ACCESS_KEY_ID, VITE_AWS_SECRET_ACCESS_KEY, VITE_AWS_LAMBDA_FUNCTION_NAME)."
  );
}

AWS.config.update({
  region: AWS_CONFIG.region,
  accessKeyId: AWS_CONFIG.accessKeyId,
  secretAccessKey: AWS_CONFIG.secretAccessKey,
});

const lambda = new AWS.Lambda({
  maxRetries: 3,
  httpOptions: { timeout: 30000 },
});

// --- Helper: Error Boundary ---
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null };
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error("Component Error:", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      console.error("ErrorBoundary caught:", this.state.error);
      return (
        <div className="bg-red-900/50 p-4 rounded-lg flex items-center space-x-2 my-2">
          <FaExclamationTriangle className="text-red-400" />
          <span className="text-red-200">
            Oops! Something went wrong rendering this part.
          </span>
        </div>
      );
    }
    return this.props.children || null;
  }
}

// --- Main Component ---
const DebuggerChatbot = () => {
  const { user } = useUser();

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedStates, setCopiedStates] = useState({});
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [showMetrics, setShowMetrics] = useState(true);
  const [cloudWatchLogs, setCloudWatchLogs] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [messages, setMessages] = useState([]);
  const [chatSessions, setChatSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState("");
  const [metrics, setMetrics] = useState({
    logEvents: 0,
    errors: 0,
    throttled: 0,
  });
  const [deletingId, setDeletingId] = useState(null);

  const messagesEndRef = useRef(null);
  const abortControllerRef = useRef(null);

  const handleError = useCallback((errorSource) => {
    let errorMessage = "An unexpected error occurred. Please try again later.";
    console.error("Error caught:", errorSource);

    if (errorSource instanceof Error) {
      errorMessage = errorSource.message;
      if (
        errorSource.name === "TimeoutError" ||
        errorSource.message.includes("timed out")
      ) {
        errorMessage =
          "The request timed out. The service might be busy or unavailable. Please try again.";
      } else if (errorSource.message.includes("NetworkError")) {
        errorMessage = "Network error. Please check your connection.";
      } else if (
        errorSource.code === "CredentialsError" ||
        errorSource.message.includes("credential")
      ) {
        errorMessage = "AWS credentials error. Please check configuration.";
      } else if (errorSource.message.startsWith("Lambda Error:")) {
        errorMessage = `Function Error: ${
          errorSource.message.substring(13) || "Unknown Lambda issue."
        }`;
      }
    } else if (typeof errorSource === "string") {
      errorMessage = errorSource;
    }

    setError(errorMessage);
    setLoading(false);
  }, []);

  const createNewSession = useCallback(
    () => ({
      id: uuidv4(),
      name: "New Chat",
      timestamp: Date.now(),
      messages: [],
      searchHistory: [],
      isNew: true,
    }),
    []
  );

  const generateSessionTitle = useCallback((msgs) => {
    const firstUserMessage = msgs.find((m) => m.sender === "user");
    if (firstUserMessage?.text) {
      const title = firstUserMessage.text.substring(0, 40);
      return title.length < firstUserMessage.text.length
        ? `${title}...`
        : title;
    }
    return "New Chat";
  }, []);

  const switchSession = useCallback(
    (sessionId, allSessions) => {
      const session = allSessions.find((s) => s.id === sessionId);
      if (session) {
        setCurrentSessionId(sessionId);
        setMessages(session.messages || []);
        setError("");
      } else {
        console.warn(`Session ID ${sessionId} not found. Creating a new one.`);
        const newSession = createNewSession();
        setChatSessions((prev) => [
          newSession,
          ...prev.filter((s) => s.id !== sessionId),
        ]);
        setCurrentSessionId(newSession.id);
        setMessages([]);
      }
    },
    [createNewSession]
  );

  const persistSessions = useCallback(
    (sessions) => {
      try {
        const sessionsToSave = sessions.map((s) => ({
          ...s,
          isNew: s.messages.length === 0 ? true : undefined,
        }));
        localStorage.setItem("chatSessions", JSON.stringify(sessionsToSave));
      } catch (err) {
        console.error("Failed to save chat history:", err);
        handleError("Could not save chat history. Storage might be full.");
      }
    },
    [handleError]
  );

  const deleteChatSession = useCallback(
    async (sessionIdToDelete) => {
      if (
        !confirm(
          "Are you sure you want to delete this chat session? This action cannot be undone."
        )
      ) {
        return;
      }
      setDeletingId(sessionIdToDelete);
      try {
        setChatSessions((prevSessions) => {
          const remainingSessions = prevSessions.filter(
            (session) => session.id !== sessionIdToDelete
          );
          if (sessionIdToDelete === currentSessionId) {
            if (remainingSessions.length > 0) {
              const sortedSessions = [...remainingSessions].sort(
                (a, b) => b.timestamp - a.timestamp
              );
              setTimeout(
                () => switchSession(sortedSessions[0].id, sortedSessions),
                0
              );
            } else {
              const newSession = createNewSession();
              setTimeout(() => switchSession(newSession.id, [newSession]), 0);
              return [newSession];
            }
          }
          return remainingSessions;
        });
      } catch (err) {
        console.error("Failed to delete chat session:", err);
        handleError("An error occurred while deleting the chat session.");
      } finally {
        setDeletingId(null);
      }
    },
    [currentSessionId, createNewSession, switchSession, handleError]
  );

  const handleNewChat = useCallback(() => {
    setChatSessions((prev) =>
      prev.map((session) => {
        if (
          session.id === currentSessionId &&
          session.isNew &&
          session.messages.length > 0
        ) {
          return {
            ...session,
            name: generateSessionTitle(session.messages),
            isNew: false,
          };
        }
        return session;
      })
    );

    const newSession = createNewSession();
    setChatSessions((prev) => {
      const updatedSessions = [newSession, ...prev];
      setTimeout(() => switchSession(newSession.id, updatedSessions), 0);
      return updatedSessions;
    });

    setIsSidebarOpen(false);
  }, [currentSessionId, generateSessionTitle, createNewSession, switchSession]);

  const fetchCloudWatchMetrics = useCallback(async () => {
    if (!AWS_CONFIG.lambdaFunction) {
      return { logEvents: 0, errors: 0, throttled: 0 };
    }
    try {
      const cloudwatch = new AWS.CloudWatch();
      const now = new Date();
      const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const metricParams = {
        Namespace: "AWS/Lambda",
        Dimensions: [
          { Name: "FunctionName", Value: AWS_CONFIG.lambdaFunction },
        ],
        StartTime: startTime,
        EndTime: now,
        Period: 86400,
        Statistics: ["Sum"],
      };
      const [invocationsData, errorsData, throttlesData] = await Promise.all([
        cloudwatch
          .getMetricStatistics({ ...metricParams, MetricName: "Invocations" })
          .promise(),
        cloudwatch
          .getMetricStatistics({ ...metricParams, MetricName: "Errors" })
          .promise(),
        cloudwatch
          .getMetricStatistics({ ...metricParams, MetricName: "Throttles" })
          .promise(),
      ]);
      return {
        logEvents: invocationsData.Datapoints?.[0]?.Sum ?? 0,
        errors: errorsData.Datapoints?.[0]?.Sum ?? 0,
        throttled: throttlesData.Datapoints?.[0]?.Sum ?? 0,
      };
    } catch (err) {
      handleError(err);
      return { logEvents: 0, errors: 0, throttled: 0 };
    }
  }, [handleError]);

  const fetchCloudWatchLogs = useCallback(async () => {
    if (!AWS_CONFIG.lambdaFunction) {
      setCloudWatchLogs(["Lambda function name not configured."]);
      return;
    }
    try {
      abortControllerRef.current?.abort("New request started");
      abortControllerRef.current = new AbortController();
      const signal = abortControllerRef.current.signal;
      const cloudwatchlogs = new AWS.CloudWatchLogs();
      const logGroupName = `/aws/lambda/${AWS_CONFIG.lambdaFunction}`;
      const data = await cloudwatchlogs
        .filterLogEvents({
          logGroupName: logGroupName,
          limit: 20,
          startTime: Date.now() - 60 * 60 * 1000,
          interleaved: true,
        })
        .promise();

      if (signal.aborted) {
        console.log("Log fetch aborted");
        return;
      }
      const logs = data.events?.map(
        (e) => e.message?.trim() || "Empty log message"
      ) || ["No recent logs found."];
      setCloudWatchLogs(logs);
    } catch (err) {
      if (err.name !== "AbortError" && err.message !== "New request started") {
        handleError(err);
        setCloudWatchLogs(["Error fetching logs."]);
      }
    }
  }, [handleError]);

  const handleSearch = useMemo(
    () =>
      throttle(
        async (termToSearch) => {
          const trimmedTerm = termToSearch.trim();
          if (!trimmedTerm) return;
          if (!user) {
            handleError("User not authenticated. Please log in.");
            return;
          }
          if (!AWS_CONFIG.lambdaFunction) {
            handleError("Lambda function not configured.");
            return;
          }

          setLoading(true);
          setError("");
          setSearchTerm("");

          const userMessage = {
            id: uuidv4(),
            sender: "user",
            text: trimmedTerm,
            timestamp: Date.now(),
          };

          setMessages((prev) => [...prev, userMessage]);
          setChatSessions((prev) =>
            prev.map((session) =>
              session.id === currentSessionId
                ? {
                    ...session,
                    messages: [...(session.messages || []), userMessage],
                    name:
                      session.isNew && session.messages.length === 0
                        ? generateSessionTitle([userMessage])
                        : session.name,
                    isNew: false,
                  }
                : session
            )
          );

          try {
            const lambdaPayload = {
              body: JSON.stringify({ prompt: trimmedTerm, userId: user.id }),
            };
            const response = await lambda
              .invoke({
                FunctionName: AWS_CONFIG.lambdaFunction,
                InvocationType: "RequestResponse",
                Payload: JSON.stringify(lambdaPayload),
              })
              .promise();

            if (response.FunctionError) {
              let errorPayload = "Unknown Lambda error";
              try {
                errorPayload =
                  JSON.parse(response.Payload.toString()).errorMessage ||
                  response.Payload.toString();
              } catch (parseErr) {
                errorPayload =
                  response.Payload?.toString() ||
                  "Could not parse error payload";
              }
              throw new Error(
                `Lambda Error: ${response.FunctionError} - ${errorPayload}`
              );
            }

            let resultBody;
            try {
              const responsePayload = JSON.parse(
                response.Payload?.toString() || "{}"
              );
              if (responsePayload.statusCode >= 400) {
                throw new Error(
                  JSON.parse(responsePayload.body || "{}")?.error ||
                    responsePayload.body ||
                    "Lambda invocation failed with status " +
                      responsePayload.statusCode
                );
              }
              resultBody = JSON.parse(responsePayload.body || "{}");
            } catch (parseErr) {
              console.error(
                "Failed to parse Lambda response:",
                response.Payload?.toString(),
                parseErr
              );
              throw new Error("Received an invalid response from the service.");
            }

            const awsResponseText =
              resultBody.response || "No meaningful response received.";
            const isMarkdown =
              awsResponseText.includes("```") ||
              awsResponseText.includes("\n*") ||
              awsResponseText.includes("\n-");
            const awsMessage = {
              id: uuidv4(),
              sender: "aws",
              text: awsResponseText,
              isMarkdown: isMarkdown,
              timestamp: Date.now(),
            };

            setMessages((prev) => [...prev, awsMessage]);
            setChatSessions((prev) =>
              prev.map((session) =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      messages: [...(session.messages || []), awsMessage],
                    }
                  : session
              )
            );
          } catch (err) {
            handleError(err);
            const currentError =
              (typeof err === "string" ? err : err.message) ||
              "Could not get response.";
            const errorMessage = {
              id: uuidv4(),
              sender: "system",
              text: `Error: ${currentError}`,
              isMarkdown: false,
              timestamp: Date.now(),
            };
            setMessages((prev) => [...prev, errorMessage]);
            setChatSessions((prev) =>
              prev.map((session) =>
                session.id === currentSessionId
                  ? {
                      ...session,
                      messages: [...(session.messages || []), errorMessage],
                    }
                  : session
              )
            );
          } finally {
            setLoading(false);
          }
        },
        1000,
        { leading: true, trailing: false }
      ),
    [handleError, user, currentSessionId, generateSessionTitle]
  );

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  const toggleMetricsPanel = useCallback(
    () => setShowMetrics((prev) => !prev),
    []
  );
  const toggleHistorySidebar = useCallback(
    () => setIsSidebarOpen((prev) => !prev),
    []
  );

  const handleCopy = useCallback((id) => {
    setCopiedStates((prev) => ({ ...prev, [id]: true }));
    const timer = setTimeout(() => {
      setCopiedStates((prev) => ({ ...prev, [id]: false }));
    }, 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    try {
      const savedSessions = localStorage.getItem("chatSessions");
      let loadedSessions = [];
      if (savedSessions) {
        loadedSessions = JSON.parse(savedSessions);
        if (!Array.isArray(loadedSessions)) {
          console.warn(
            "Invalid chat history found in localStorage. Resetting."
          );
          loadedSessions = [];
        }
      }

      if (loadedSessions.length > 0) {
        loadedSessions.sort((a, b) => b.timestamp - a.timestamp);
        setChatSessions(loadedSessions);
        switchSession(loadedSessions[0].id, loadedSessions);
      } else {
        const newSession = createNewSession();
        setChatSessions([newSession]);
        switchSession(newSession.id, [newSession]);
      }
    } catch (err) {
      console.error("Failed to load chat history:", err);
      handleError("Could not load previous chat sessions.");
      const newSession = createNewSession();
      setChatSessions([newSession]);
      switchSession(newSession.id, [newSession]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createNewSession, switchSession, handleError]);

  useEffect(() => {
    if (chatSessions.length > 0 || (currentSessionId && messages.length > 0)) {
      const debouncedPersist = debounce(
        () => persistSessions(chatSessions),
        500
      );
      debouncedPersist();
      return () => debouncedPersist.cancel();
    }
  }, [chatSessions, persistSessions, currentSessionId, messages.length]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  useEffect(() => {
    const fetchAndSetData = async () => {
      try {
        const metricsData = await fetchCloudWatchMetrics();
        setMetrics(metricsData);
        await fetchCloudWatchLogs();
      } catch (error) {
        console.error("Error during periodic fetch:", error);
      }
    };
    fetchAndSetData();
    const intervalId = setInterval(fetchAndSetData, 30000);
    return () => {
      clearInterval(intervalId);
      abortControllerRef.current?.abort("Component unmounting");
    };
  }, [fetchCloudWatchMetrics, fetchCloudWatchLogs]);

  useEffect(() => {
    return () => {
      handleSearch.cancel();
    };
  }, [handleSearch]);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setShowMetrics(false);
      } else {
        setShowMetrics(true);
      }
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const renderMessage = useCallback(
    (message) => (
      <ErrorBoundary key={message.id}>
        <div
          className={`flex ${
            message.sender === "user"
              ? "justify-end"
              : message.sender === "system"
              ? "justify-center"
              : "justify-start"
          } mb-4 animate-fade-in`}
        >
          {message.sender !== "user" && message.sender !== "system" && (
            <img
              src="https://cdn0.iconfinder.com/data/icons/social-flat-rounded-rects/512/aws-512.png"
              alt="AWS"
              className="rounded-full w-8 h-8 lg:w-10 lg:h-10 mr-2 lg:mx-2 self-start object-cover shadow-md flex-shrink-0"
            />
          )}
          <div
            className={`p-3 lg:p-4 rounded-lg max-w-sm sm:max-w-md md:max-w-lg lg:max-w-2xl xl:max-w-3xl shadow-md ${
              message.sender === "user"
                ? "bg-blue-600 text-white"
                : message.sender === "system"
                ? "bg-red-800/70 text-red-100 text-sm italic w-full max-w-xl text-center"
                : "bg-gray-700 text-gray-100"
            }`}
          >
            {message.isMarkdown ? (
              <div className="prose prose-sm prose-invert max-w-none">
                <ReactMarkdown
                  components={{
                    code({ inline, className, children, ...props }) {
                      const match = /language-(\w+)/.exec(className || "");
                      const codeText = String(children).replace(/\n$/, "");
                      return !inline && match ? (
                        <div className="relative my-2 bg-[#282c34] rounded overflow-hidden">
                          <span className="text-xs text-gray-400 absolute top-1 left-2">
                            {match[1]}
                          </span>
                          <SyntaxHighlighter
                            style={dark}
                            language={match[1]}
                            PreTag="div"
                            customStyle={{
                              margin: 0,
                              padding: "1.5rem 1rem 1rem 1rem",
                              backgroundColor: "transparent",
                              fontSize: "0.875rem",
                            }}
                            wrapLongLines={true}
                          >
                            {codeText}
                          </SyntaxHighlighter>
                          <CopyToClipboard
                            text={codeText}
                            onCopy={() => handleCopy(message.id)}
                          >
                            <button className="absolute top-1 right-1 bg-gray-600 hover:bg-gray-500 text-white px-2 py-0.5 rounded text-xs transition-colors">
                              {copiedStates[message.id] ? "Copied!" : "Copy"}
                            </button>
                          </CopyToClipboard>
                        </div>
                      ) : (
                        <code
                          className="bg-gray-600/50 px-1 py-0.5 rounded text-sm"
                          {...props}
                        >
                          {" "}
                          {children}{" "}
                        </code>
                      );
                    },
                    a: ({ ...props }) => (
                      <a
                        {...props}
                        className="text-blue-400 hover:underline"
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    ),
                    ul: ({ ...props }) => (
                      <ul {...props} className="list-disc list-inside my-1" />
                    ),
                    ol: ({ ...props }) => (
                      <ol
                        {...props}
                        className="list-decimal list-inside my-1"
                      />
                    ),
                    p: ({ ...props }) => (
                      <p {...props} className="mb-2 last:mb-0" />
                    ),
                  }}
                >
                  {message.text}
                </ReactMarkdown>
              </div>
            ) : (
              <div className="text-gray-100 whitespace-pre-wrap break-words">
                {message.text}
              </div>
            )}
          </div>
          {message.sender === "user" && user?.imageUrl && (
            <img
              src={user.imageUrl}
              alt="User"
              className="rounded-full w-8 h-8 lg:w-10 lg:h-10 ml-2 lg:mx-2 self-start object-cover shadow-md flex-shrink-0"
            />
          )}
        </div>
      </ErrorBoundary>
    ),
    [copiedStates, user?.imageUrl, handleCopy]
  );

  return (
    <div className="flex flex-col lg:flex-row h-screen bg-gray-900 text-gray-100 overflow-hidden">
      {/* Metrics Panel */}
      {showMetrics && (
        <div className="w-full lg:w-1/4 lg:max-w-xs xl:max-w-sm border-b lg:border-b-0 lg:border-r border-gray-700 p-4 flex flex-col h-auto lg:h-screen overflow-y-auto hide-scrollbar">
          <button
            onClick={toggleMetricsPanel}
            className="lg:hidden text-gray-400 hover:text-white absolute top-2 right-2 z-10 p-1 bg-gray-800/50 rounded-full"
            aria-label="Close metrics"
          >
            <X size={20} />
          </button>
          <h3 className="text-lg font-semibold mb-4 pt-6 lg:pt-0">
            CloudWatch Metrics
          </h3>
          <div className="bg-gray-800/50 rounded-lg p-3 mb-4">
            <h4 className="text-sm font-medium mb-2 text-gray-300">
              Last 24 Hours
            </h4>
            <div className="grid grid-cols-3 gap-2">
              <div className="bg-gray-700/50 p-2 rounded text-center">
                <p className="text-xs text-gray-400">Invocations</p>
                <p className="text-lg font-bold">{metrics.logEvents}</p>
              </div>
              <div className="bg-gray-700/50 p-2 rounded text-center">
                <p className="text-xs text-gray-400">Errors</p>
                <p
                  className={`text-lg font-bold ${
                    metrics.errors > 0 ? "text-red-400" : ""
                  }`}
                >
                  {metrics.errors}
                </p>
              </div>
              <div className="bg-gray-700/50 p-2 rounded text-center">
                <p className="text-xs text-gray-400">Throttles</p>
                <p
                  className={`text-lg font-bold ${
                    metrics.throttled > 0 ? "text-yellow-400" : ""
                  }`}
                >
                  {metrics.throttled}
                </p>
              </div>
            </div>
          </div>
          <h3 className="text-lg font-semibold mb-2">Recent Logs</h3>
          <div className="flex-1 overflow-y-auto space-y-1.5 bg-gray-800/30 p-2 rounded hide-scrollbar">
            {cloudWatchLogs.length > 0 &&
            typeof cloudWatchLogs[0] === "string" ? (
              cloudWatchLogs.map((log, i) => (
                <div
                  key={i}
                  className={`p-1.5 rounded text-xs font-mono break-words ${
                    log.toLowerCase().includes("error")
                      ? "bg-red-900/60 text-red-100"
                      : log.toLowerCase().includes("warn")
                      ? "bg-yellow-900/60 text-yellow-100"
                      : "bg-gray-700/50 text-gray-300"
                  }`}
                  title={log}
                >
                  {log.length > 150 ? log.substring(0, 150) + "..." : log}
                </div>
              ))
            ) : (
              <p className="text-sm text-gray-500 italic p-2">
                No logs found or loading...
              </p>
            )}
          </div>
        </div>
      )}

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Input Area */}
        <div className="p-3 lg:p-4 border-b border-gray-700 flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-4 items-center">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSearch(searchTerm);
              }
            }}
            placeholder="Ask AWS Debugger (e.g., 'Why is my Lambda timing out?')"
            className="flex-1 w-full bg-gray-800 rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            disabled={loading}
          />
          <button
            onClick={() => handleSearch(searchTerm)}
            disabled={loading || !searchTerm.trim()}
            className="w-full sm:w-auto bg-blue-600 px-5 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center space-x-2 flex-shrink-0"
          >
            {loading ? (
              <>
                <FaSpinner className="animate-spin" size={18} />
                <span>Asking...</span>
              </>
            ) : (
              <span>Ask</span>
            )}
          </button>
        </div>

        {/* Message List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 hide-scrollbar relative">
          {messages.length === 0 && !loading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-gray-600 p-8 pointer-events-none">
              <img
                src="/aws-debugger-icon.svg"
                alt="AWS Debugger"
                className="w-24 h-24 mb-4 opacity-50"
                onError={(e) => (e.target.style.display = "none")}
              />
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="w-20 h-20 mb-4 opacity-50 text-gray-700 hidden"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                data-fallback-icon
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"></path>
              </svg>
              <script
                dangerouslySetInnerHTML={{
                  __html: `
                        try {
                            const img = document.querySelector('img[alt="AWS Debugger"]');
                            const fallback = document.querySelector('[data-fallback-icon]');
                            if (img && fallback) {
                                img.onerror = () => { img.style.display='none'; fallback.style.display='block'; };
                                if (img.complete && img.naturalWidth === 0) { img.onerror(); }
                            } else if (fallback && !img) {
                                fallback.style.display = 'block';
                            }
                        } catch (e) { console.error("Error setting fallback icon:", e); }
                    `,
                }}
              />
              <h2 className="text-xl font-semibold text-gray-500">
                AWS Debugger
              </h2>
              <p className="mt-2">
                Start a new debugging session by asking a question below.
              </p>
            </div>
          ) : (
            messages.map(renderMessage)
          )}
          {loading && messages.length === 0 && (
            <div className="flex justify-center items-center pt-10">
              <FaSpinner className="animate-spin text-blue-500" size={24} />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* History Sidebar */}
      <div
        className={` fixed inset-0 z-40 bg-gray-900/95 backdrop-blur-sm p-4 flex flex-col lg:static lg:z-auto lg:bg-transparent lg:backdrop-blur-none lg:w-1/4 lg:max-w-xs xl:max-w-sm lg:border-l border-gray-700 lg:h-screen transition-transform duration-300 ease-in-out ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 overflow-y-auto hide-scrollbar `}
        aria-label="Chat History"
      >
        <div className="flex justify-between items-center mb-4 flex-shrink-0">
          <h3 className="text-lg font-semibold">Chat History</h3>
          <button
            onClick={handleNewChat}
            className="text-sm px-3 py-1 bg-orange-500 rounded-full hover:bg-orange-600 transition-colors text-white"
            title="Start a new chat session"
          >
            + New Chat
          </button>
          <button
            onClick={toggleHistorySidebar}
            className="lg:hidden text-gray-400 hover:text-white p-1"
            aria-label="Close history"
          >
            <X size={24} />
          </button>
        </div>
        <div className="space-y-1.5 flex-1 overflow-y-auto hide-scrollbar pr-1">
          {chatSessions.map((session) => (
            <div
              key={session.id}
              className={`group flex items-center justify-between w-full p-2 rounded cursor-pointer transition-colors duration-150 truncate ${
                session.id === currentSessionId
                  ? "bg-blue-700/60"
                  : "bg-gray-800/70 hover:bg-gray-700/80"
              }`}
              onClick={() => {
                if (session.id !== currentSessionId)
                  switchSession(session.id, chatSessions);
                if (window.innerWidth < 1024) setIsSidebarOpen(false);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  if (session.id !== currentSessionId)
                    switchSession(session.id, chatSessions);
                  if (window.innerWidth < 1024) setIsSidebarOpen(false);
                }
              }}
            >
              <div className="flex-1 text-left truncate mr-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate font-medium" title={session.name}>
                    {session.isNew && session.messages.length === 0 ? (
                      <i>New Chat</i>
                    ) : (
                      session.name
                    )}
                  </span>
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {new Date(session.timestamp).toLocaleDateString()}{" "}
                  {new Date(session.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChatSession(session.id);
                }}
                className={`p-1 text-gray-400 hover:text-red-500 focus:text-red-500 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0 rounded-full hover:bg-gray-600/50 focus:outline-none focus:ring-1 focus:ring-red-500 ${
                  deletingId === session.id ? "opacity-100" : ""
                }`}
                title="Delete chat"
                disabled={deletingId === session.id}
                aria-label={`Delete chat session titled ${session.name}`}
              >
                {deletingId === session.id ? (
                  <FaSpinner className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
              </button>
            </div>
          ))}
          {chatSessions.length === 0 && (
            <p className="text-sm text-gray-500 italic p-2 text-center">
              No chat history yet.
            </p>
          )}
        </div>
      </div>

      {/* Mobile Floating Toggle Buttons */}
      <button
        onClick={toggleMetricsPanel}
        className={`lg:hidden fixed bottom-20 ${
          isSidebarOpen ? "right-20" : "right-4"
        } bg-gray-700 p-3 rounded-full shadow-lg z-50 transition-all text-gray-300 hover:text-white hover:bg-gray-600`}
        aria-label={showMetrics ? "Hide Metrics" : "Show Metrics"}
      >
        {showMetrics ? <ChevronLeft size={20} /> : <ChevronRight size={20} />}
      </button>
      <button
        onClick={toggleHistorySidebar}
        className="lg:hidden fixed bottom-4 right-4 bg-blue-600 p-3 rounded-full shadow-lg z-50 transition-all text-white hover:bg-blue-700"
        aria-label={isSidebarOpen ? "Close History" : "Open History"}
      >
        {isSidebarOpen ? <X size={20} /> : <FaHistory size={20} />}
      </button>

      {/* Error Toast */}
      {error && (
        <div className="fixed bottom-4 left-4 right-4 md:left-auto md:max-w-md bg-red-600 p-4 rounded-lg shadow-lg flex items-center space-x-3 z-[60] animate-slide-up">
          <FaExclamationTriangle
            className="text-white flex-shrink-0"
            size={20}
          />
          <span className="text-white text-sm flex-1">{error}</span>
          <button
            onClick={() => setError("")}
            className="text-red-100 hover:text-white ml-auto flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
};

export default DebuggerChatbot;
