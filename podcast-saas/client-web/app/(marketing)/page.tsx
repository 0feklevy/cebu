import { HomeSidebar } from '../../components/HomeSidebar';
import { HomeHero } from '../../components/HomeHero';

export default function LandingPage() {
  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <HomeSidebar />
      <main className="flex-1 overflow-y-auto">
        <HomeHero />
      </main>
    </div>
  );
}
