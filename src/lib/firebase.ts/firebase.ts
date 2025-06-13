import { initializeApp, getApps } from "firebase/app";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBOe_RNCic6dgUCTdvaBz29chyS3j4wmpI",
  authDomain: "veil-app-97d3c.firebaseapp.com",
  projectId: "veil-app-97d3c",
  storageBucket: "veil-app-97d3c.appspot.com",
  messagingSenderId: "462168695989",
  appId: "1:462168695989:web:d63d9ea11eb87557f4cafc"
};

// Initialize Firebase
let app;
if (!getApps().length) {
  app = initializeApp(firebaseConfig);
}

export default app;
