import { HomeSidebar } from '../../components/HomeSidebar';
import { LandingHero } from '../../components/LandingHero';

export default function LandingPage() {
  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <HomeSidebar />
      <main className="flex-1 overflow-y-auto">
        <LandingHero />
      </main>
    </div>
  );
}
