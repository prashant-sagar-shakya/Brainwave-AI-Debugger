import React from "react";
import { useNavigate } from "react-router-dom";
import { SignIn, SignUp, useUser } from "@clerk/clerk-react";

const Auth: React.FC = () => {
  const [isLogin, setIsLogin] = useState(true);
  const { isLoaded, isSignedIn, user } = useUser();
  const navigate = useNavigate();

  React.useEffect(() => {
    if (isLoaded && isSignedIn && user) {
      // Store user data in MongoDB
      const storeUserData = async () => {
        try {
          const response = await fetch(
            `${import.meta.env.VITE_API_URL}/api/users/register`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                email: user.primaryEmailAddress?.emailAddress,
                clerkId: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                imageUrl: user.imageUrl,
              }),
            }
          );

          if (!response.ok) {
            throw new Error("Failed to store user data");
          }

          // Redirect to debugger page after successful registration
          navigate("/debugger");
        } catch (error) {
          console.error("Error storing user data:", error);
        }
      };

      storeUserData();
    }
  }, [isLoaded, isSignedIn, user, navigate]);

  if (!isLoaded) {
    return <div>Loading...</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8 bg-gray-800 p-8 rounded-xl shadow-lg">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-white">
            {isLogin ? "Sign in to your account" : "Create new account"}
          </h2>
        </div>

        {isLogin ? (
          <SignIn routing="path" path="/sign-in" />
        ) : (
          <SignUp routing="path" path="/sign-up" />
        )}

        <div className="text-center">
          <button
            onClick={() => setIsLogin(!isLogin)}
            className="text-blue-400 hover:text-blue-500 text-sm"
          >
            {isLogin
              ? "Need an account? Sign up"
              : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Auth;
