# Brainwave

Brainwave is a powerful AI-powered chat application built with modern technologies. It features a sleek and customizable UI/UX design, intelligent debugging capabilities, and seamless cloud integration. The application combines the power of React for the frontend, Clerk for authentication, and AWS services for backend functionality.

## Preview

![Thumbnail](/brainwave.png)

## Features

- **Modern UI/UX**: Built with React and Tailwind CSS for a responsive and visually appealing interface
- **AI-Powered Debugging**: Intelligent debugging capabilities to help identify and resolve issues
- **Secure Authentication**: Integrated with Clerk for robust user authentication and management
- **Cloud Integration**: Leverages AWS Lambda and other AWS services for scalable backend operations
- **Real-time Chat**: Smooth and responsive chat interface for AI interactions
- **Customizable**: Easily adaptable UI components and themes
- **Developer Friendly**: Well-structured codebase with modern development practices

## Tech Stack

- **Frontend**: React.js with Vite, Tailwind CSS
- **Authentication**: Clerk
- **Cloud Services**: AWS Lambda, AWS Region (ap-south-1)
- **Database**: MongoDB
- **Development Tools**: ESLint, PostCSS

## Prerequisites

- Node.js (v14 or higher)
- npm or yarn package manager
- MongoDB account
- Clerk account for authentication
- AWS account with appropriate credentials
- Google Cloud account for Gemini API

## Environment Setup

1. Create a `.env` file in the root directory with the following variables:

```env
VITE_CLERK_PUBLISHABLE_KEY=your_clerk_key
CLERK_SECRET_KEY=your_clerk_secret
VITE_GEMINI_API_KEY=your_gemini_api_key
MONGO_URI=your_mongodb_uri
JWT_SECRET=your_jwt_secret
VITE_AWS_REGION=your_aws_region
VITE_AWS_ACCESS_KEY_ID=your_aws_access_key
VITE_AWS_SECRET_ACCESS_KEY=your_aws_secret_key
VITE_AWS_LAMBDA_FUNCTION_NAME=your_lambda_function
VITE_API_URL=http://localhost:5000
PORT=5000
```

## Installation

1. Clone the repository:

```bash
git clone https://github.com/prashant-sagar-shakya/Brainwave.git
cd Brainwave
```

2. Install dependencies:

```bash
npm install
# or
yarn install
```

3. Start the development server:

```bash
npm run dev
# or
yarn dev
```

## Usage

1. Access the application at `http://localhost:5000`
2. Sign in using Clerk authentication
3. Start debugging with AI-powered assistance
4. Customize the UI components as needed
5. Integrate with your specific AI models or use the default Gemini integration

## Contributing

1. Fork the repository
2. Create your feature branch: `git checkout -b feature/YourFeature`
3. Commit your changes: `git commit -m 'Add YourFeature'`
4. Push to the branch: `git push origin feature/YourFeature`
5. Submit a pull request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, please open an issue in the GitHub repository or contact the maintainers.
