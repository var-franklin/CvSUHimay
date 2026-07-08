//file path: web/src/main.jsx

import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { AppContextProvider } from './context/AppContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'
import './index.css'
import App from './App.jsx'

export const GOOGLE_CLIENT_ID =  import.meta.env.VITE_GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID) {
	console.error(
		'Missing VITE_GOOGLE_CLIENT_ID.'
	);
}

createRoot(document.getElementById('root')).render(
	<BrowserRouter>
		<GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
			<ThemeProvider>
				<AppContextProvider>
					<App />
				</AppContextProvider>
			</ThemeProvider>
		</GoogleOAuthProvider>
	</BrowserRouter>
)














































